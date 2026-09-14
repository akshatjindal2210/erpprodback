import dbQuery from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";

/**
 * Purchase Shortage — DB layer. Uses the existing ims_shortage table (no new tables).
 */

const ALLOWED_FILTER_FIELDS = [ "id", "itemdcode", "type", "types", "approved", "month", "grpname", "from_date", "to_date" ];

const ALLOWED_SORT_FIELDS = [ "id", "itemdcode", "itemcode", "grpname", "type", "qty", "month", "approved", "created_at", "updated_at" ];

const ALLOWED_UPDATE_FIELDS = [ "itemdcode", "itemcode", "grpname", "type", "qty", "month", "remarks", "approved", "approved_by", "approved_at", "updated_by", "updated_at" ];

/** Audit cols store user name snapshot (not live user id). */
const DEFAULT_FIELDS = [ "s.id", "s.itemdcode", "s.itemcode", "s.grpname", "s.type", "s.qty", "s.month", "s.remarks",
  "s.approved", "s.approved_by", "s.approved_at", "s.created_by", "s.created_at", "s.updated_by", "s.updated_at", "s.deleted_by", "s.deleted_at",
  "s.created_by AS created_by_name", "s.updated_by AS updated_by_name", "s.approved_by AS approved_by_name", "s.deleted_by AS deleted_by_name",
];

export { DEFAULT_FIELDS as SHORTAGE_DEFAULT_FIELDS };

export const findShortages = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [] } = options;

  const values = [];
  let i = 1;
  const conditions = ["s.is_deleted = false"];

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    // DATE FILTERS filter on the shortage month (business calendar), not created_at
    if (key === "from_date") {
      values.push(String(val).slice(0, 10));
      conditions.push(`s.month >= $${i++}::date`);
      continue;
    }

    if (key === "to_date") {
      values.push(String(val).slice(0, 10));
      conditions.push(`s.month <= $${i++}::date`);
      continue;
    }

    // NORMAL FILTERS (SAFE)
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "grpname") {
      const needle = String(val).trim();
      if (!needle) continue;
      values.push(needle);
      conditions.push(`LOWER(TRIM(COALESCE(s.grpname, ''))) = LOWER($${i++})`);
      continue;
    }

    if (key === "types") {
      const arr = (Array.isArray(val) ? val : []).map((x) => String(x).trim()).filter(Boolean);
      if (!arr.length) continue;
      values.push(arr);
      conditions.push(`s.type = ANY($${i++}::text[])`);
      continue;
    }

    values.push(val);
    conditions.push(`s.${key} = $${i++}`);
  }

  // SEARCH
  if (search) {
    const searchIndex = i;
    values.push(`%${search}%`);

    conditions.push(`(
      s.itemcode ILIKE $${searchIndex} OR
      s.grpname ILIKE $${searchIndex} OR
      s.type ILIKE $${searchIndex} OR
      s.itemdcode::text ILIKE $${searchIndex}
    )`);

    i++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${T.SHORTAGE} s ${where}`,
    values
  );

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  // SAFE SORTING
  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "id";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM ${T.SHORTAGE} s
     ${where}
     ORDER BY s.${sortByField} ${sortOrder}
     LIMIT $${i++} OFFSET $${i++}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count) / safeLimit),
  };
};

export const findShortage = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;
  const conditions = ["s.is_deleted = false"];

  for (const key of keys) {
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    conditions.push(`s.${key} = $${i++}`);
  }

  if (conditions.length === 1) return null;

  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${T.SHORTAGE} s
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

export const insertShortage = async (data) => {
  const {
    itemdcode,
    itemcode = null,
    grpname = null,
    type,
    qty,
    month,
    remarks = null,
    approved = false,
    approved_by = null,
    approved_at = null,
    created_by,
  } = data;

  const [row] = await dbQuery(
    `INSERT INTO ${T.SHORTAGE}
       (itemdcode, itemcode, grpname, type, qty, month, remarks,
        approved, approved_by, approved_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      itemdcode,
      itemcode,
      grpname,
      type,
      qty,
      month,
      remarks,
      Boolean(approved),
      approved_by,
      approved_at,
      created_by,
    ]
  );

  return row;
};

export const updateShortages = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (ALLOWED_UPDATE_FIELDS.includes(k)) {
      safeFields[k] = fields[k];
    }
  }

  for (const k in filters) {
    if (ALLOWED_FILTER_FIELDS.includes(k)) {
      safeFilters[k] = filters[k];
    }
  }

  const fieldKeys = Object.keys(safeFields);
  const filterKeys = Object.keys(safeFilters);

  if (!fieldKeys.length) throw new Error("No valid fields to update");
  if (!filterKeys.length) throw new Error("No valid filters provided");

  const values = [...Object.values(safeFields), ...Object.values(safeFilters)];
  const setClause = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const whereClause = filterKeys
    .map((k, i) => `${k} = $${fieldKeys.length + i + 1}`)
    .join(" AND ");

  const [row] = await dbQuery(
    `UPDATE ${T.SHORTAGE}
     SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING *`,
    values
  );

  return row ?? null;
};

export const deleteShortages = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) throw new Error("No filters provided");

  const values = [];
  let i = 1;
  const conditions = [];

  for (const k of keys) {
    if (!ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }

  if (!conditions.length) throw new Error("Invalid filters");

  values.push(meta.deleted_by ?? null);

  await dbQuery(
    `UPDATE ${T.SHORTAGE}
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`,
    values
  );
};
