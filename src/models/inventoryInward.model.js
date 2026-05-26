import dbQuery from "../config/db.js";
import { BOX_TX_TYPES } from "../constants/boxTransactionTypes.js";
import { logBoxTransactionSafe, singlePackingFromRows } from "../utils/logBoxTransaction.js";
import { sqlBoxInHand } from "../utils/boxInventorySql.js";

// ─── ALLOWED CONFIG ─────────────────────────
const ALLOWED_FILTER_FIELDS = ["in_uid", "packing_number", "approved", "from_date", "to_date"];

const ALLOWED_SORT_FIELDS = ["created_at", "approved_at", "updated_at", "packing_number", "in_uid"];

const ALLOWED_UPDATE_FIELDS = ["packing_number", "remarks", "approved", "approved_by", "approved_at", "updated_by", "updated_at"];

// ─── JOINS ─────────────────────────
// Join users for creator/updater/deleter/approver display names
const JOINS = `
  LEFT JOIN users u_cr  ON i.created_by  = u_cr.id
  LEFT JOIN users u_upd ON i.updated_by  = u_upd.id
  LEFT JOIN users u_dl  ON i.deleted_by  = u_dl.id
  LEFT JOIN users u_ap  ON i.approved_by = u_ap.id
`;

// ─── DEFAULT SELECT FIELDS ─────────────────────────
const DEFAULT_FIELDS = [
  "i.in_uid", "i.packing_number", "i.remarks",
  "i.approved", "i.approved_by", "i.approved_at",
  "i.created_by", "i.created_at",
  "i.updated_by", "i.updated_at",
  "i.is_deleted", "i.deleted_by", "i.deleted_at",
  "u_cr.name  AS created_by_name",
  "u_upd.name AS updated_by_name",
  "u_dl.name  AS deleted_by_name",
  "u_ap.name  AS approved_by_name"
];

// ─── FIND MULTIPLE ─────────────────────────
export const findInventoryInwards = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [], permission = {} } = options;

  const values = [];
  let i = 1;

  const conditions = ["i.is_deleted = false"];

  // Permission-based date restriction (can_view_days)
  if (permission?.can_view_days > 0) {
    conditions.push(`i.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    // DATE FILTERS
    if (key === "from_date") {
      values.push(val);
      conditions.push(`i.created_at >= $${i++}`);
      continue;
    }

    if (key === "to_date") {
      values.push(val);
      conditions.push(`i.created_at <= $${i++}`);
      continue;
    }

    // NORMAL FILTERS (Validation against allowed list)
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    values.push(val);
    conditions.push(`i.${key} = $${i++}`);
  }

  // Search packing number, remarks, or creator name
  if (search) {
    const searchTerm = `%${search}%`;
    values.push(searchTerm);

    conditions.push(`(
      i.packing_number ILIKE $${i} OR
      i.remarks ILIKE $${i} OR
      u_cr.name ILIKE $${i}
    )`);
    i++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // COUNT (With Joins for consistency)
  const [{ count }] = await dbQuery(`SELECT COUNT(*) AS count FROM inventory_inwards i ${JOINS} ${where}`, values);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  // SAFE SORTING
  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";
  
  const orderByClause = `i.${sortByField}`;

  const queryValues = [...values, safeLimit, offset];

  const selectFields = fields.length 
    ? fields.map(f => {
        if (f.includes('.')) return f;
        if (f.toLowerCase().includes(' as ')) return f;
        return `i.${f}`;
      }).join(", ") 
    : DEFAULT_FIELDS.join(", ");

  const rows = await dbQuery(
    `SELECT ${selectFields}
     FROM inventory_inwards i
     ${JOINS}
     ${where}
     ORDER BY ${orderByClause} ${sortOrder} 
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
export const findInventoryInward = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;
  const conditions = ["i.is_deleted = false"];

  for (const key of keys) {
    // Allow in_uid and listed filter fields only
    if (key !== "in_uid" && !ALLOWED_FILTER_FIELDS.includes(key)) continue;

    values.push(filters[key]);
    conditions.push(`i.${key} = $${i++}`);
  }

  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM inventory_inwards i
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  if (!row) return null;

  // Fetch associated boxes with location details
  const boxes = await dbQuery(`
    SELECT 
      b.box_no_uid, 
      b.qty,
      b.packing_number,
      b.location_id,
      lm.rack_no,
      lm.shelf_no
    FROM box_table b
    LEFT JOIN location_master lm ON b.location_id = lm.location_id
    WHERE b.in_uid = $1 AND b.is_deleted = false
  `, [row.in_uid]);

  // Group boxes by location for frontend (include qty for UI totals)
  const locationMap = {};
  boxes.forEach(box => {
    if (!locationMap[box.location_id]) {
      locationMap[box.location_id] = {
        location_id: box.location_id,
        name: `${box.rack_no}${box.shelf_no ? box.shelf_no.toString().toUpperCase() : ""}`,
        boxes: []
      };
    }
    locationMap[box.location_id].boxes.push({
      box_no_uid: box.box_no_uid,
      qty: box.qty != null ? Number(box.qty) : 0,
      packing_number: box.packing_number != null ? String(box.packing_number).trim() : null,
    });
  });

  row.locations = Object.values(locationMap);

  return row;
};

// ─── INSERT ───────────────────────────────
export const insertInventoryInward = async (data) => {
  const { packing_number, remarks, created_by, approved = true, approved_by = null, approved_at = null } = data;

  const [row] = await dbQuery(
    `INSERT INTO inventory_inwards
     (packing_number, remarks, approved, approved_by, approved_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [packing_number, remarks, approved, approved_by, approved_at, created_by]
  );

  return row;
};

// ─── UPDATE ───────────────────────────────
export const updateInventoryInwards = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (ALLOWED_UPDATE_FIELDS.includes(k)) safeFields[k] = fields[k];
  }

  for (const k in filters) {
    if (k === "in_uid" || ALLOWED_FILTER_FIELDS.includes(k)) safeFilters[k] = filters[k];
  }

  safeFields.updated_at = new Date();

  const fieldKeys  = Object.keys(safeFields);
  const filterKeys = Object.keys(safeFilters);

  if (!fieldKeys.length) throw new Error("No valid fields to update");
  if (!filterKeys.length) throw new Error("No valid filters provided");

  const values = [...Object.values(safeFields), ...Object.values(safeFilters)];

  const setClause = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const whereClause = filterKeys.map((k, i) => `${k} = $${fieldKeys.length + i + 1}`).join(" AND ");

  const [row] = await dbQuery(
    `UPDATE inventory_inwards
     SET ${setClause}
     WHERE ${whereClause}
     RETURNING *`,
    values
  );

  return row;
};

// ─── DELETE (SOFT) ────────────────────────
export const deleteInventoryInwards = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) throw new Error("No filters provided");

  const values = [];
  let i = 1;
  const conditions = [];

  for (const k of keys) {
    if (k !== "in_uid" && !ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }

  if (!conditions.length) throw new Error("Invalid filters");

  values.push(meta.deleted_by ?? null);

  await dbQuery(
    `UPDATE inventory_inwards
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`,
    values
  );
};

// ─── BOX LINK RESET FOR INWARD ─────────────────────
export const resetBoxesForInward = async (in_uid, userId = null) => {
  if (!in_uid) return [];
  const rows = await dbQuery(
    `UPDATE box_table
     SET in_uid = NULL,
         location_id = NULL,
         updated_at = NOW()
     WHERE in_uid = $1
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose`,
    [in_uid]
  );
  if (rows?.length) {
    logBoxTransactionSafe({
      transaction_type: BOX_TX_TYPES.INWARD_UNLINK,
      source_module: "inventory_inward",
      source_id: String(in_uid),
      packing_number: singlePackingFromRows(rows),
      user_id: userId,
      rows,
      details: {
        in_uid,
        packing_numbers: [...new Set(rows.map((r) => r.packing_number).filter(Boolean))],
      },
    });
  }
  return rows;
};

// ─── PACKING AREA (in-hand boxes, no location yet) ─────────────────────
const PACKING_AREA_PN = `NULLIF(TRIM(b.packing_number::text), '')`;
const PACKING_AREA_SORT = {
  packing_number: "packing_number",
  box_count: "box_count",
  stock_qty: "stock_qty",
};

/** Expect YYYY-MM-DD from the client (DateRangeFilter). Avoid Date parsing (timezone drift). */
function ymdFromPackingAreaFilter(value) {
  if (value == null || String(value).trim() === "") return null;
  const m = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function appendPackingDocDtFilter(conditions, values, packingNoExpr, filters = {}) {
  const fromYmd = ymdFromPackingAreaFilter(filters.from_date);
  const toYmd = ymdFromPackingAreaFilter(filters.to_date);
  if (!fromYmd && !toYmd) return;

  let i = values.length + 1;
  const dtParts = [];
  if (fromYmd) {
    values.push(fromYmd);
    dtParts.push(`dp.doc_dt >= $${i++}::date`);
  }
  if (toYmd) {
    values.push(toYmd);
    dtParts.push(`dp.doc_dt <= $${i++}::date`);
  }

  conditions.push(`EXISTS (
    SELECT 1 FROM dailyprod dp
    WHERE dp.doc_no::text = ${packingNoExpr}
      AND dp.doc_dt IS NOT NULL
      AND ${dtParts.join(" AND ")}
  )`);
}

/** Production stickers only (excludes SA add placeholder boxes). */
const PACKING_AREA_HAS_PRODUCTION_STICKER = `
  EXISTS (
    SELECT 1
    FROM box_table b2
    WHERE NULLIF(TRIM(b2.packing_number::text), '') = ${PACKING_AREA_PN}
      AND b2.is_deleted = false
      AND (b2.sa_entry_type IS DISTINCT FROM 'stock_out')
      AND NOT (b2.sa_entry_type = 'stock_in' AND b2.sa_id IS NOT NULL)
      AND ${sqlBoxInHand("b2")}
      AND b2.location_id IS NULL
  )
`;

/**
 * Packing area summary: in-hand boxes with no location assigned (grouped by packing no.).
 * Dispatched / out-entry / stock-adjustment-out boxes are excluded via sqlBoxInHand.
 */
export const findPackingAreaByPacking = async (options = {}) => {
  const { search, sort = {}, page = 1, limit = 1000, filters = {} } = options;

  const values = [];
  let i = 1;
  const conditions = [
    "b.is_deleted = false",
    sqlBoxInHand("b"),
    "b.location_id IS NULL",
    `${PACKING_AREA_PN} IS NOT NULL`,
    PACKING_AREA_HAS_PRODUCTION_STICKER,
  ];

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`${PACKING_AREA_PN} ILIKE $${i++}`);
  }

  appendPackingDocDtFilter(conditions, values, PACKING_AREA_PN, filters);

  const where = `WHERE ${conditions.join(" AND ")}`;

  const [{ count }] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM (
       SELECT ${PACKING_AREA_PN} AS packing_number
       FROM box_table b
       ${where}
       GROUP BY ${PACKING_AREA_PN}
     ) sub`,
    values
  );

  const sortBy = PACKING_AREA_SORT[sort.by] || "packing_number";
  const sortOrder = sort.order === "DESC" ? "DESC" : "ASC";

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;
  const queryValues = [...values, safeLimit, offset];

  const rows = await dbQuery(
    `SELECT
       ${PACKING_AREA_PN} AS packing_number,
       COUNT(*)::int AS box_count,
       COALESCE(SUM(b.qty), 0)::bigint AS stock_qty
     FROM box_table b
     ${where}
     GROUP BY ${PACKING_AREA_PN}
     ORDER BY ${sortBy} ${sortOrder}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    queryValues
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count) / safeLimit) || 0,
  };
};

const PACKING_AREA_BOX_WHERE = (alias = "b") => [
  `${alias}.is_deleted = false`,
  sqlBoxInHand(alias),
  `${alias}.location_id IS NULL`,
  `NULLIF(TRIM(${alias}.packing_number::text), '') IS NOT NULL`,
];

const PACKING_AREA_BOX_SORT = {
  box_no_uid: "b.box_no_uid",
  packing_number: "packing_number",
  qty: "b.qty",
  created_at: "b.created_at",
};

/**
 * Individual boxes in packing area (in-hand, no location).
 * Out/dispatched/SA-minus boxes are excluded via sqlBoxInHand — same as inventory report.
 */
export const findPackingAreaBoxes = async (options = {}) => {
  const { search, packing_number, sort = {}, page = 1, limit = 1000, filters = {} } = options;

  const values = [];
  let i = 1;
  const conditions = [...PACKING_AREA_BOX_WHERE("b")];
  const pnExpr = `NULLIF(TRIM(b.packing_number::text), '')`;

  if (packing_number) {
    values.push(String(packing_number).trim());
    conditions.push(`${pnExpr} = $${i++}`);
  }

  appendPackingDocDtFilter(conditions, values, pnExpr, filters);

  if (search) {
    values.push(`%${search}%`);
    const searchIdx = values.length;
    conditions.push(`(
      b.box_no_uid ILIKE $${searchIdx} OR
      NULLIF(TRIM(b.packing_number::text), '') ILIKE $${searchIdx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const [{ count }] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM box_table b ${where}`,
    values
  );

  const sortCol = PACKING_AREA_BOX_SORT[sort.by] || "b.box_no_uid";
  const sortOrder = sort.order === "DESC" ? "DESC" : "ASC";

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;
  const queryValues = [...values, safeLimit, offset];

  const rows = await dbQuery(
    `SELECT
       b.box_uid,
       b.box_no_uid,
       ${pnExpr} AS packing_number,
       COALESCE(b.qty, 0)::int AS qty,
       COALESCE(b.is_loose, false) AS is_loose,
       b.created_at
     FROM box_table b
     ${where}
     ORDER BY ${sortCol} ${sortOrder}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    queryValues
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count) / safeLimit) || 0,
  };
};