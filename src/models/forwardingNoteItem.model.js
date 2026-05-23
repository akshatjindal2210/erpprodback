import dbQuery from "../config/db.js";

// ─── CONFIG ─────────────────────────
// Master-level columns available for filters/search
const ALLOWED_FILTER_FIELDS = ["id", "fuid", "item_dcode", "approved", "out_entry_locked", "from_date", "to_date", "po_number", "acc_code"];
const ALLOWED_SORT_FIELDS = ["created_at", "qty", "fuid", "po_number", "packing_number"];
const ALLOWED_UPDATE_FIELDS = [
  "item_dcode", "packing_number", "box", "box_qty", 
  "loose_box", "loose_box_qty", "total_qty",
  "approved", "approved_by", "approved_at", "updated_by", "updated_at"
];

// ─── JOINS (MASTER + ACCOUNT + ITEM) ─────────────────────────
// Items (fi) joined to master (fnm) on fuid
const JOINS = `
  INNER JOIN forwarding_note_master fnm ON fi.fuid = fnm.fuid
  LEFT JOIN users u_cr       ON fi.created_by = u_cr.id
  LEFT JOIN users u_upd      ON fi.updated_by = u_upd.id
  LEFT JOIN users u_ap       ON fi.approved_by = u_ap.id
  LEFT JOIN users u_mcr      ON fnm.created_by = u_mcr.id
  LEFT JOIN users u_mupd     ON fnm.updated_by = u_mupd.id
  LEFT JOIN users u_mdl      ON fnm.deleted_by = u_mdl.id
  LEFT JOIN users u_map      ON fnm.approved_by = u_map.id
  LEFT JOIN users u_lock     ON fnm.out_entry_locked_by = u_lock.id
  LEFT JOIN users u_bill     ON fnm.bill_updated_by = u_bill.id
`;

// ─── SELECT FIELDS (MERGING BOTH JSONs) ─────────────────────────
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
  "fnm.created_by",
  "fnm.created_at",
  "fnm.updated_by",
  "fnm.updated_at",
  "fnm.deleted_by",
  "fnm.deleted_at",
  "fnm.acc_code::text AS acc_name",
  "u_mcr.name AS created_by_name",
  "u_mupd.name AS updated_by_name",
  "u_mdl.name AS deleted_by_name",
  "u_map.name AS approved_by_name",
  "u_lock.name AS out_entry_locked_by_name",
  "u_bill.name AS bill_updated_by_name"
];

// ─── FIND MULTIPLE ─────────────────────────
export const findForwardingNoteItems = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, permission = {} } = options;

  const values = [];
  let i = 1;
  const conditions = ["fi.is_deleted = false"];

  // Permission-based date restriction (can_view_days)
  if (permission?.can_view_days > 0) {
    conditions.push(`fi.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`fi.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`fi.created_at <= $${i++}`);
      continue;
    }

    // Filters on master (fnm) columns
    if (key === "po_number" || key === "acc_code" || key === "out_entry_locked") {
      values.push(val);
      conditions.push(`fnm.${key} = $${i++}`);
      continue;
    }

    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(val);
    conditions.push(`fi.${key} = $${i++}`);
  }

  // SEARCH (Cross-table search)
  if (search) {
    const searchTerm = `%${search}%`;
    values.push(searchTerm);
    conditions.push(`(
      fi.item_dcode::text ILIKE $${i} OR 
      fnm.po_number ILIKE $${i} OR
      fnm.acc_code::text ILIKE $${i} OR
      fnm.vehicle_number ILIKE $${i} OR
      fi.packing_number ILIKE $${i}
    )`);
    i++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // COUNT
  const [{ count }] = await dbQuery(`
    SELECT COUNT(*) AS count 
    FROM forwarding_note_item_wise fi 
    ${JOINS} 
    ${where}`, values);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  // SORTING (always qualify — fi and fnm share columns like fuid / created_at / qty)
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
    FROM forwarding_note_item_wise fi
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

// ─── FIND ONE ─────────────────────────────
export const findForwardingNoteItem = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;
  const conditions = ["fi.is_deleted = false"];

  for (const key of keys) {
    if (key !== "id" && !ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    conditions.push(`fi.${key} = $${i++}`);
  }

  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM forwarding_note_item_wise fi
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

// ─── INSERT ───────────────────────────────
export const insertForwardingNoteItem = async (data) => {
  const fields = [
    "fuid", "item_dcode", "packing_number", "box", "box_qty", 
    "loose_box", "loose_box_qty", "total_qty", "created_by"
  ];
  const values = fields.map(f => data[f] ?? null);
  const placeholders = fields.map((_, idx) => `$${idx + 1}`).join(", ");

  const [row] = await dbQuery(
    `INSERT INTO forwarding_note_item_wise (${fields.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    values
  );
  return row;
};

// ─── UPDATE ───────────────────────────────
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
    `UPDATE forwarding_note_item_wise SET ${setClause} WHERE ${whereClause} RETURNING *`,
    values
  );
  return row;
};

// ─── DELETE (SOFT) ────────────────────────
export const deleteForwardingNoteItems = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  const values = [];
  let i = 1;
  const conditions = [];

  for (const k of keys) {
    if (k !== "id" && k !== "fuid" && !ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`fi.${k} = $${i++}`);
  }

  values.push(meta.deleted_by ?? null);
  await dbQuery(
    `UPDATE forwarding_note_item_wise fi SET is_deleted = true, deleted_at = NOW(), deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`,
    values
  );
};