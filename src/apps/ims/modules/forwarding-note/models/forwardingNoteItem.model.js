import dbQuery from "../../../../../config/db/db.js";
import { applyForwardingOutEntryListFilter } from "../utils/list/forwardingNoteListFilters.js";

/** Forwarding Note item-wise rows — joined to master for list filters.
 * Audit cols store user name snapshot (not live user id). */

// Master-level columns available for filters/search
const ALLOWED_FILTER_FIELDS = ["id", "fuid", "item_dcode", "approved", "out_entry_locked", "from_date", "to_date", "po_number", "acc_code"];
const ALLOWED_SORT_FIELDS = ["created_at", "qty", "fuid", "po_number", "packing_number"];
const ALLOWED_UPDATE_FIELDS = [
  "item_dcode", "packing_number", "box", "box_qty", 
  "loose_box", "loose_box_qty", "total_qty",
  "approved", "approved_by", "approved_at", "updated_by", "updated_at"
];

// Items (fi) joined to master (fnm) on fuid
const JOINS = `
  INNER JOIN ims_forwarding_note_master fnm ON fi.fuid = fnm.fuid
  LEFT JOIN LATERAL (
    SELECT oe.out_uid, oe.scan_complete, oe.approved, oe.boxes_scanned, oe.boxes_required
    FROM ims_out_entry oe
    WHERE oe.fuid = fnm.fuid AND oe.is_deleted = false
    ORDER BY oe.out_uid DESC
    LIMIT 1
  ) oe ON true
`;

const DEFAULT_FIELDS = [
  // Item-wise data
  "fi.id",
  "fi.fuid",
  "fi.item_dcode",
  "fi.packing_number",
  "fi.box",
  "fi.box_qty",
  "fi.loose_box",
  "fi.loose_box_qty",
  "fi.total_qty",
  "fi.schno",
  "fi.item_dcode::text AS item_code",
  "NULL::text AS item_desc",
  // Master-level data (must match summary/action context)
  "fnm.acc_code",
  "fnm.po_number",
  "fnm.remarks",
  "fnm.transporter_name",
  "fnm.vehicle_number",
  "fnm.cartage",
  "fnm.total_items",
  "fnm.bill_no",
  "fnm.bill_updated_by",
  "fnm.bill_updated_at",
  "fnm.timestamp AS timestamp",
  "fnm.approved",
  "fnm.approved_by",
  "fnm.approved_at",
  "fnm.out_entry_locked",
  "fnm.out_entry_locked_by",
  "fnm.out_entry_locked_at",
  "oe.out_uid AS out_entry_uid",
  "COALESCE(oe.scan_complete, false) AS out_entry_scan_complete",
  "(oe.out_uid IS NOT NULL AND COALESCE(oe.scan_complete, false) = true) AS out_entry_complete",
  "fnm.created_by",
  "fnm.created_at",
  "fnm.updated_by",
  "fnm.updated_at",
  "fnm.deleted_by",
  "fnm.deleted_at",
  "fnm.acc_code::text AS acc_name",
  "fnm.created_by AS created_by_name",
  "fnm.updated_by AS updated_by_name",
  "fnm.deleted_by AS deleted_by_name",
  "fnm.approved_by AS approved_by_name",
  "fnm.out_entry_locked_by AS out_entry_locked_by_name",
  "fnm.bill_updated_by AS bill_updated_by_name"
];

export const findForwardingNoteItems = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, permission = {} } = options;

  const values = [];
  let i = 1;
  const conditions = ["fi.is_deleted = false", "fnm.is_deleted = false"];

  // Permission-based date restriction (can_view_days)
  if (permission?.can_view_days > 0) {
    conditions.push(`fi.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`COALESCE(fnm.timestamp, fnm.created_at, fi.created_at) >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`COALESCE(fnm.timestamp, fnm.created_at, fi.created_at) <= $${i++}`);
      continue;
    }

    // Filters on master (fnm) columns
    if (key === "po_number" || key === "acc_code") {
      values.push(val);
      conditions.push(`fnm.${key} = $${i++}`);
      continue;
    }
    if (key === "out_entry_locked") {
      const locked = val === true || val === "true";
      conditions.push(`COALESCE(fnm.out_entry_locked, false) = ${locked ? "true" : "false"}`);
      continue;
    }

    if (applyForwardingOutEntryListFilter(conditions, key, val)) continue;

    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(val);
    conditions.push(`fi.${key} = $${i++}`);
  }

  // SEARCH (Cross-table search)
  if (search) {
    const searchTerm = `%${search}%`;
    values.push(searchTerm);
    conditions.push(`(
      fi.fuid::text ILIKE $${i} OR
      fi.item_dcode::text ILIKE $${i} OR
      fi.schno ILIKE $${i} OR
      fnm.po_number ILIKE $${i} OR
      fnm.acc_code::text ILIKE $${i} OR
      fnm.vehicle_number ILIKE $${i} OR
      fnm.bill_no ILIKE $${i} OR
      fi.packing_number ILIKE $${i} OR
      EXISTS (
        SELECT 1 FROM ims_dailyprod dp
        WHERE NULLIF(TRIM(fi.packing_number::text), '') = NULLIF(TRIM(dp.doc_no::text), '')
          AND (dp.item_code ILIKE $${i} OR dp.item_desc ILIKE $${i})
      )
    )`);
    i++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // COUNT
  const [{ count }] = await dbQuery(`
    SELECT COUNT(*) AS count 
    FROM ims_forwarding_note_item_wise fi 
    ${JOINS} 
    ${where}`, values);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  // SORTING (always qualify fi and fnm share columns like fuid / created_at / qty)
  const SORT_COLUMN_MAP = {
    created_at: "fi.created_at",
    qty: "fi.qty",
    fuid: "fi.fuid",
    po_number: "fnm.po_number",
    packing_number: "fi.packing_number"
  };
  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by)
    ? (SORT_COLUMN_MAP[sort.by] || "fi.created_at")
    : "fi.created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";

  const rows = await dbQuery(`
    SELECT ${DEFAULT_FIELDS.join(", ")}
    FROM ims_forwarding_note_item_wise fi
    ${JOINS}
    ${where}
    ORDER BY ${sortByField} ${sortOrder} 
    LIMIT $${i++} OFFSET $${i++}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit
  };
};

export const findForwardingNoteItem = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;
  const conditions = ["fi.is_deleted = false", "fnm.is_deleted = false"];

  for (const key of keys) {
    if (key !== "id" && !ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    conditions.push(`fi.${key} = $${i++}`);
  }

  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ims_forwarding_note_item_wise fi
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

export const insertForwardingNoteItem = async (data, { client } = {}) => {
  const fields = [
    "fuid", "item_dcode", "packing_number", "box", "box_qty", 
    "loose_box", "loose_box_qty", "total_qty", "schno", "created_by"
  ];
  const values = fields.map(f => {
    if (f === "schno") {
      const raw = data.schno;
      return raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;
    }
    return data[f] ?? null;
  });
  const placeholders = fields.map((_, idx) => `$${idx + 1}`).join(", ");
  const run = client?.query
    ? async (sql, params) => {
        const result = await client.query(sql, params);
        return result.rows;
      }
    : dbQuery;

  const rows = await run(
    `INSERT INTO ims_forwarding_note_item_wise (${fields.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    values
  );
  return client?.query ? rows[0] : rows[0];
};

export const updateForwardingNoteItems = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (ALLOWED_UPDATE_FIELDS.includes(k)) safeFields[k] = fields[k];
  }
  for (const k in filters) {
    if (k === "id" || ALLOWED_FILTER_FIELDS.includes(k)) safeFilters[k] = filters[k];
  }

  safeFields.updated_at = new Date();
  const fieldKeys = Object.keys(safeFields);
  const filterKeys = Object.keys(safeFilters);

  if (!fieldKeys.length || !filterKeys.length) throw new Error("Invalid update request");

  const values = [...Object.values(safeFields), ...Object.values(safeFilters)];
  const setClause = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const whereClause = filterKeys.map((k, i) => `${k} = $${fieldKeys.length + i + 1}`).join(" AND ");

  const [row] = await dbQuery(
    `UPDATE ims_forwarding_note_item_wise SET ${setClause} WHERE ${whereClause} RETURNING *`,
    values
  );
  return row;
};

export const deleteForwardingNoteItems = async (filters = {}, meta = {}, { client } = {}) => {
  const keys = Object.keys(filters);
  const values = [];
  let i = 1;
  const conditions = [];

  for (const k of keys) {
    if (k !== "id" && k !== "fuid" && !ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }

  values.push(meta.deleted_by ?? null);
  const sql = `UPDATE ims_forwarding_note_item_wise SET is_deleted = true, deleted_at = NOW(), deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`;

  if (client?.query) {
    await client.query(sql, values);
    return;
  }
  await dbQuery(sql, values);
};

/** Active item rows for one forwarding note — used for reserve validation on approve. */
export const findActiveForwardingNoteItemsByFuid = async (fuid, { client } = {}) => {
  const run = client?.query
    ? async (sql, params) => {
        const result = await client.query(sql, params);
        return result.rows;
      }
    : dbQuery;

  return run(
    `SELECT fi.item_dcode,
            fi.packing_number,
            fi.box,
            fi.box_qty,
            fi.loose_box,
            fi.loose_box_qty,
            fi.total_qty,
            TRIM(COALESCE(NULLIF(TRIM(fi.schno::text), ''), NULLIF(TRIM(f.schno::text), ''))) AS schno
     FROM ims_forwarding_note_item_wise fi
     INNER JOIN ims_forwarding_note_master f
       ON f.fuid = fi.fuid AND f.is_deleted = false
     WHERE fi.fuid = $1 AND fi.is_deleted = false
     ORDER BY fi.id ASC`,
    [Number(fuid)]
  );
};