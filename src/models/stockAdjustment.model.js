import dbQuery from "../config/db.js";

// --- Configuration ---
const ALLOWED_SELECT_FIELDS = [
  "adjustment_id", "item_dcode", "item_code", "qty", "unit", "remarks", "approved",
  "entry_type", "packing_number", "financial_year", "per_box_qty", "box_count_impact", "removed_box_ids",
  "created_at", "updated_at", "approved_at", "created_by", "updated_by", "approved_by",
  "created_by_name", "updated_by_name", "approved_by_name"
];

const ALLOWED_FILTER_FIELDS = ["adjustment_id", "item_dcode", "approved", "is_deleted", "from_date", "to_date", "entry_type", "packing_number"];

const ALLOWED_UPDATE_FIELDS = [
  "item_dcode", "qty", "unit", "remarks", "approved", "approved_by", "approved_at",
  "updated_by", "updated_at", "is_deleted", "deleted_by", "deleted_at",
  "entry_type", "packing_number", "financial_year", "per_box_qty", "box_count_impact", "removed_box_ids"
];

const ALLOWED_SORT_FIELDS = ["adjustment_id", "item_dcode", "qty", "created_at", "approved", "entry_type", "packing_number"];

const JOINS = `
  LEFT JOIN users u_cr ON s.created_by = u_cr.id
  LEFT JOIN users u_up ON s.updated_by = u_up.id
  LEFT JOIN users u_ap ON s.approved_by = u_ap.id
`;

const DEFAULT_FIELDS = [
  "s.*",
  "s.item_dcode::text AS item_code",
  "u_cr.name AS created_by_name",
  "u_up.name AS updated_by_name",
  "u_ap.name AS approved_by_name"
];

const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

export const findAdjustments = async (options = {}) => {
  const { 
    filters = {}, 
    fields = [], 
    sort = {}, 
    page = 1, 
    limit = 10, 
    search = null,
    permission = {}
  } = options;

  const values = [];
  let i = 1;

  const safeFields = fields.length > 0 
    ? fields.map(f => {
        if (f === "item_code") return "s.item_dcode::text AS item_code";
        if (f === "created_by_name") return "u_cr.name AS created_by_name";
        if (f === "updated_by_name") return "u_up.name AS updated_by_name";
        if (f === "approved_by_name") return "u_ap.name AS approved_by_name";
        return `s.${f}`;
      }).join(", ")
    : DEFAULT_FIELDS.join(", ");

  // Conditions array
  const conditions = ["s.is_deleted = false"];

  // Permission-based date restriction (can_view_days)
  if (permission?.can_view_days > 0) {
    conditions.push(`s.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  // Apply filters
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date" || key === "fromDate") {
      values.push(val);
      conditions.push(`s.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date" || key === "toDate") {
      values.push(val);
      conditions.push(`s.created_at <= $${i++}`);
      continue;
    }
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
    values.push(val);
    conditions.push(`s.${key} = $${i++}`);
  }

  // Search D-code, remarks, item code, packing, financial year
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(
      CAST(s.item_dcode AS TEXT) ILIKE $${i} OR 
      s.remarks ILIKE $${i} OR
      COALESCE(s.packing_number::text, '') ILIKE $${i} OR
      COALESCE(s.financial_year::text, '') ILIKE $${i}
    )`);
    i++;
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  
  // Sort & Pagination
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "adjustment_id";
  const safeSortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";

  const safePage = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  // Count Query
  const countValues = [...values];
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM stock_adjustment s ${JOINS} ${whereClause}`, 
    countValues
  );

  // Main Query
  const mainValues = [...values, safeLimit, offset];
  const rows = await dbQuery(
    `SELECT ${safeFields} 
     FROM stock_adjustment s 
     ${JOINS} 
     ${whereClause} 
     ORDER BY s.${safeSortBy} ${safeSortOrder} 
     LIMIT $${i++} OFFSET $${i++}`,
    mainValues
  );

  return { 
    data: rows, 
    total: parseInt(count), 
    page: safePage, 
    limit: safeLimit 
  };
};

export const findAdjustmentById = async (id) => {
  const result = await findAdjustments({
    filters: { adjustment_id: id },
    page: 1,
    limit: 1
  });
  return result.data?.[0] ?? null;
};

// --- CREATE ---
export const insertAdjustment = async (data) => {
  const keys = Object.keys(data);
  const values = Object.values(data);
  const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(", ");
  
  const [row] = await dbQuery(
    `INSERT INTO stock_adjustment (${keys.join(", ")}) 
     VALUES (${placeholders}) 
     RETURNING *`,
    values
  );
  return row;
};

export const insertAdjustmentTx = async (client, data) => {
  const keys = Object.keys(data);
  const values = Object.values(data);
  const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(", ");
  const { rows } = await client.query(
    `INSERT INTO stock_adjustment (${keys.join(", ")}) 
     VALUES (${placeholders}) 
     RETURNING *`,
    values
  );
  return rows[0];
};

// --- UPDATE ---
export const updateAdjustments = async (fields = {}, filters = {}) => {
  const fieldKeys = Object.keys(fields);
  const filterKeys = Object.keys(filters);
  
  if (!fieldKeys.length) throw new Error("No fields to update");
  if (!filterKeys.length) throw new Error("No filters provided");

  for (const key of fieldKeys) assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const setClause = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const values = [...Object.values(fields), ...Object.values(filters)];

  return await dbQuery(
    `UPDATE stock_adjustment 
     SET ${setClause} 
     WHERE ${whereClause} AND is_deleted = false 
     RETURNING *`, 
    values
  );
};

export const updateAdjustmentsTx = async (client, fields = {}, filters = {}) => {
  const fieldKeys = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length) throw new Error("No fields to update");
  if (!filterKeys.length) throw new Error("No filters provided");

  for (const key of fieldKeys) assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const setClause = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const vals = [...Object.values(fields), ...Object.values(filters)];

  const { rows } = await client.query(
    `UPDATE stock_adjustment 
     SET ${setClause} 
     WHERE ${whereClause} AND is_deleted = false 
     RETURNING *`,
    vals
  );
  return rows;
};

/** Latest `financial_year` on stock adjustment for this packing (same IMS source as SA view drawer). */
export const findFinancialYearForPacking = async (packing_number) => {
  const pn = String(packing_number ?? "").trim();
  if (!pn) return null;
  const [row] = await dbQuery(
    `SELECT financial_year
     FROM stock_adjustment
     WHERE trim(packing_number::text) = trim($1::text)
       AND financial_year IS NOT NULL
       AND trim(financial_year::text) <> ''
     ORDER BY adjustment_id DESC
     LIMIT 1`,
    [pn]
  );
  const fy = row?.financial_year;
  return fy != null && String(fy).trim() !== "" ? String(fy).trim() : null;
};

export const findFinancialYearForSaId = async (adjustment_id) => {
  const id = Number(adjustment_id);
  if (!Number.isFinite(id) || id < 1) return null;
  const [row] = await dbQuery(
    `SELECT financial_year
     FROM stock_adjustment
     WHERE adjustment_id = $1::int
       AND financial_year IS NOT NULL
       AND trim(financial_year::text) <> ''
     LIMIT 1`,
    [id]
  );
  const fy = row?.financial_year;
  return fy != null && String(fy).trim() !== "" ? String(fy).trim() : null;
};