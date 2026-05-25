import dbQuery from "../config/db.js";
import { sqlBoxInHand } from "../utils/boxInventorySql.js";

// ─── ALLOWED CONFIG ─────────────────────────
const ALLOWED_FILTER_FIELDS = ["fuid", "acc_code", "po_number", "approved", "out_entry_locked", "out_entry_available", "from_date", "to_date"];

const ALLOWED_SORT_FIELDS = ["created_at", "approved_at", "updated_at", "po_number", "fuid"];

const ALLOWED_UPDATE_FIELDS = [
  "acc_code", "po_number", "remarks", "transporter_name", "transporter_id",
  "vehicle_number", "cartage", "total_items", "bill_no",
  "bill_updated_by", "bill_updated_at",
  "approved", "approved_by", "approved_at", "updated_by", "updated_at"
];

// ─── JOINS ─────────────────────────
const JOINS = `
  LEFT JOIN users u_cr   ON f.created_by  = u_cr.id
  LEFT JOIN users u_upd  ON f.updated_by  = u_upd.id
  LEFT JOIN users u_dl   ON f.deleted_by  = u_dl.id
  LEFT JOIN users u_ap   ON f.approved_by = u_ap.id
  LEFT JOIN users u_lock ON f.out_entry_locked_by = u_lock.id
  LEFT JOIN users u_bill ON f.bill_updated_by = u_bill.id
`;

// ─── DEFAULT SELECT FIELDS ─────────────────────────
const DEFAULT_FIELDS = [
  "f.*",
  "f.acc_code::text AS acc_name",
  "u_cr.name  AS created_by_name",
  "u_upd.name AS updated_by_name",
  "u_dl.name  AS deleted_by_name",
  "u_ap.name  AS approved_by_name",
  "u_lock.name AS out_entry_locked_by_name",
  "u_bill.name AS bill_updated_by_name"
];

// ─── FIND MULTIPLE ─────────────────────────
export const findForwardingNotes = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [], permission = {} } = options;

  const values = [];
  let i = 1;

  const conditions = ["f.is_deleted = false"];

  // Permission-based date restriction (can_view_days)
  if (permission?.can_view_days > 0) {
    conditions.push(`f.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`f.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`f.created_at <= $${i++}`);
      continue;
    }

    if (key === "out_entry_available") {
      const includeAvailable = val === true || val === "true";
      if (includeAvailable) {
        conditions.push(`NOT EXISTS (
          SELECT 1
          FROM out_entry oe
          WHERE oe.fuid = f.fuid
            AND oe.is_deleted = false
        )`);
      }
      continue;
    }

    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(val);
    conditions.push(`f.${key} = $${i++}`);
  }

  // SEARCH
  if (search) {
    const searchTerm = `%${search}%`;
    values.push(searchTerm);
    conditions.push(`(
      f.fuid::text ILIKE $${i} OR
      f.po_number ILIKE $${i} OR
      f.transporter_name ILIKE $${i} OR
      f.vehicle_number ILIKE $${i} OR
      f.bill_no ILIKE $${i} OR
      f.acc_code::text ILIKE $${i}
    )`);
    i++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // COUNT
  const [{ count }] = await dbQuery(`SELECT COUNT(*) AS count FROM forwarding_note_master f ${JOINS} ${where}`, values);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  // SORTING
  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";

  const queryValues = [...values, safeLimit, offset];

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM forwarding_note_master f
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     ORDER BY f.${sortByField} ${sortOrder} 
     LIMIT $${i++} OFFSET $${i++}`,
    queryValues
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(count / safeLimit)
  };
};

  // ─── FIND ONE ─────────────────────────────
export const findForwardingNote = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;
  const conditions = ["f.is_deleted = false"];

  for (const key of keys) {
    if (key !== "fuid" && !ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    conditions.push(`f.${key} = $${i++}`);
  }

  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM forwarding_note_master f
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  if (!row) return null;

  // Fetch items for this forwarding note
  const items = await dbQuery(
    `SELECT fi.*, fi.item_dcode::text AS item_code, NULL::text AS itemdesc
     FROM forwarding_note_item_wise fi
     WHERE fi.fuid = $1 AND fi.is_deleted = false
     ORDER BY fi.id ASC`,
    [row.fuid]
  );

  // Group items by item_dcode while preserving original insertion order
  const groupedItems = [];
  const itemMap = new Map();

  for (const item of items) {
    const key = item.item_dcode;
    if (!itemMap.has(key)) {
      const newItem = {
        item_dcode: item.item_dcode,
        item_code: item.item_code,
        itemdesc: item.itemdesc,
        total_qty: 0,
        breakdowns: []
      };
      itemMap.set(key, newItem);
      groupedItems.push(newItem);
    }
    const groupedItem = itemMap.get(key);
    groupedItem.total_qty += Number(item.total_qty);
    // Breakdowns already sorted by fi.id ASC from query
    groupedItem.breakdowns.push(item);
  }

  row.items = groupedItems;
  return row;
};

// ─── INSERT ───────────────────────────────
export const insertForwardingNote = async (data) => {
  const fields = ["acc_code", "po_number", "remarks", "transporter_name", "transporter_id", "vehicle_number", "cartage", "total_items", "bill_no", "approved", "created_by"];
  const hasBill = data.bill_no != null && String(data.bill_no).trim() !== "";
  if (hasBill) {
    fields.push("bill_updated_by", "bill_updated_at");
  }
  const values = fields.map((f) => {
    if (f === "bill_updated_by") return data.bill_updated_by ?? data.created_by ?? null;
    if (f === "bill_updated_at") return data.bill_updated_at ?? new Date();
    return data[f] ?? null;
  });
  const placeholders = fields.map((_, idx) => `$${idx + 1}`).join(", ");

  const [row] = await dbQuery(
    `INSERT INTO forwarding_note_master (${fields.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    values
  );
  return row;
};

// ─── UPDATE ───────────────────────────────
export const updateForwardingNotes = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (ALLOWED_UPDATE_FIELDS.includes(k)) safeFields[k] = fields[k];
  }
  for (const k in filters) {
    if (k === "fuid" || ALLOWED_FILTER_FIELDS.includes(k)) safeFilters[k] = filters[k];
  }

  safeFields.updated_at = new Date();
  const fieldKeys = Object.keys(safeFields);
  const filterKeys = Object.keys(safeFilters);

  if (!fieldKeys.length || !filterKeys.length) throw new Error("Invalid update request");

  const values = [...Object.values(safeFields), ...Object.values(safeFilters)];
  const setClause = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const whereClause = filterKeys.map((k, i) => `${k} = $${fieldKeys.length + i + 1}`).join(" AND ");

  const [row] = await dbQuery(
    `UPDATE forwarding_note_master
     SET ${setClause}
     WHERE ${whereClause}
       AND out_entry_locked = false
     RETURNING *`,
    values
  );

  if (row) return row;

  // Hard security guard: if row is locked, block update at model level.
  const lockFilterValue = safeFilters.fuid;
  if (lockFilterValue !== undefined && lockFilterValue !== null) {
    const [lockRow] = await dbQuery(
      `SELECT out_entry_locked FROM forwarding_note_master WHERE fuid = $1 LIMIT 1`,
      [lockFilterValue]
    );
    if (lockRow?.out_entry_locked) {
      const err = new Error("This forwarding note is locked because it is linked to an out entry.");
      err.statusCode = 409;
      throw err;
    }
  }
  return null;
};

/** Bill is entered after out entry — allowed even when `out_entry_locked` is true. */
export const updateForwardingNoteBillNo = async ({ fuid, bill_no, userId }) => {
  const normalized =
    bill_no === null || bill_no === undefined ? null : String(bill_no).trim() || null;

  const [row] = await dbQuery(
    `UPDATE forwarding_note_master
     SET bill_no = $2,
         bill_updated_by = $3,
         bill_updated_at = NOW()
     WHERE fuid = $1
       AND is_deleted = false
     RETURNING *`,
    [fuid, normalized, userId]
  );
  return row || null;
};

// ─── DELETE (SOFT) ────────────────────────
export const deleteForwardingNotes = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  const values = [];
  let i = 1;
  const conditions = [];

  for (const k of keys) {
    if (k !== "fuid" && !ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }

  values.push(meta.deleted_by ?? null);
  const [row] = await dbQuery(
    `UPDATE forwarding_note_master
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}
       AND out_entry_locked = false
     RETURNING fuid`,
    values
  );

  if (row) return;

  const fuidFilterIndex = keys.findIndex((k) => k === "fuid");
  if (fuidFilterIndex >= 0) {
    const fuidValue = filters.fuid;
    const [lockRow] = await dbQuery(
      `SELECT out_entry_locked FROM forwarding_note_master WHERE fuid = $1 LIMIT 1`,
      [fuidValue]
    );
    if (lockRow?.out_entry_locked) {
      const err = new Error("This forwarding note is locked because it is linked to an out entry.");
      err.statusCode = 409;
      throw err;
    }
  }
};

export const lockForwardingNoteForOutEntry = async ({ fuid, userId }) => {
  const [row] = await dbQuery(
    `UPDATE forwarding_note_master
     SET out_entry_locked = true,
         out_entry_locked_by = COALESCE(out_entry_locked_by, $2),
         out_entry_locked_at = COALESCE(out_entry_locked_at, NOW())
     WHERE fuid = $1
       AND is_deleted = false
     RETURNING fuid, out_entry_locked, out_entry_locked_at`,
    [fuid, userId]
  );
  return row || null;
};

export const isForwardingNoteLockedForOutEntry = async (fuid) => {
  const [row] = await dbQuery(
    `SELECT out_entry_locked
     FROM forwarding_note_master
     WHERE fuid = $1
       AND is_deleted = false
     LIMIT 1`,
    [fuid]
  );
  return Boolean(row?.out_entry_locked);
};

export const unlockForwardingNoteForOutEntry = async ({ fuid }) => {
  const [row] = await dbQuery(
    `UPDATE forwarding_note_master
     SET out_entry_locked = false,
         out_entry_locked_by = NULL,
         out_entry_locked_at = NULL
     WHERE fuid = $1
       AND is_deleted = false
     RETURNING fuid, out_entry_locked, out_entry_locked_at`,
    [fuid]
  );
  return row || null;
};

// ─── HELPER: Transporter suggestions (from past Forwarding Notes) ─────────────
export const findForwardingNoteTransporters = async ({ acc_code, search, limit = 200 } = {}) => {
  if (acc_code == null || acc_code === "") return [];
  const n = Number(acc_code);
  if (!Number.isFinite(n)) return [];

  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  const values = [n];
  let i = 2;

  const conditions = [`is_deleted = false`, `acc_code = $1`, `transporter_name IS NOT NULL`, `BTRIM(transporter_name) <> ''`,];

  if (search && String(search).trim()) {
    const q = `%${String(search).trim().slice(0, 100)}%`;
    values.push(q);
    const idx = i++;
    conditions.push(`(transporter_name ILIKE $${idx} OR COALESCE(transporter_id, '') ILIKE $${idx})`);
  }

  const rows = await dbQuery(
    `SELECT transporter_name, transporter_id, MAX(created_at) AS last_used_at
     FROM forwarding_note_master
     WHERE ${conditions.join(" AND ")}
     GROUP BY transporter_name, transporter_id
     ORDER BY last_used_at DESC
     LIMIT $${i}`,
    [...values, safeLimit]
  );

  return rows || [];
};

export const findAvailableBoxes = async (item_dcode) => {
  const query = `
    SELECT 
      b.box_uid, 
      b.box_no_uid, 
      b.packing_number, 
      b.qty, 
      b.location_id, 
      b.is_loose,
      b.override_cust,
      dp.doc_no, 
      dp.doc_dt, 
      dp.job_card_no, 
      dp.acc_code, 
      dp.item_dcode AS itemdcode
    FROM dailyprod dp
    INNER JOIN box_table b 
      ON dp.doc_no::text = b.packing_number::text 
    WHERE 
      dp.item_dcode::int = $1::int  
      AND dp.sticker_generated = true 
      AND ${sqlBoxInHand("b")}
    ORDER BY b.created_at ASC;
  `;

  // Number(item_dcode) ensures parameter is a number
  return await dbQuery(query, [Number(item_dcode)]);
};