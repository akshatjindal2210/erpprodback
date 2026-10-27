import dbQuery from "../../../../../config/db/db.js";
import { MST_TABLES } from "../../../../../config/db/dbTables.js";

const TABLE = MST_TABLES.SHIFTS;

const ALLOWED_SELECT_FIELDS = ["id", "code", "start_time", "end_time", "is_active", "created_at", "updated_at"];
const ALLOWED_FILTER_FIELDS = ["id", "code", "is_active", "from_date", "to_date"];
const ALLOWED_UPDATE_FIELDS = ["code", "start_time", "end_time", "is_active", "updated_at"];
const ALLOWED_SORT_FIELDS = ["id", "code", "start_time", "end_time", "is_active", "created_at"];

const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

export const findShifts = async (options = {}) => {
  const {
    filters = {},
    fields = [],
    sort = {},
    page = 1,
    limit = 10,
    search = null,
  } = options;

  const values = [];
  let i = 1;

  const mappedSelect = fields.length > 0 ? fields.filter((f) => ALLOWED_SELECT_FIELDS.includes(f)).map((f) => `s.${f}`) : ["s.*"];
  const safeFields = mappedSelect.join(", ");

  const conditions = ["TRUE"];

  for (const [key, val] of Object.entries(filters)) {
    if (key === "from_date") {
      values.push(val);
      conditions.push(`s.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`s.created_at <= $${i++}`);
      continue;
    }
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
    values.push(val);
    conditions.push(`s.${key} = $${i++}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`s.code ILIKE $${i++}`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const rawSortBy = sort.by || "code";
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(rawSortBy) ? rawSortBy : "code";
  const safeSortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  const safePage = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, parseInt(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const countValues = [...values];
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} s ${whereClause}`,
    countValues
  );

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT ${safeFields} FROM ${TABLE} s
     ${whereClause}
     ORDER BY s.${safeSortBy} ${safeSortOrder}
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  return {
    data: rows,
    total: parseInt(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(parseInt(count) / safeLimit),
  };
};

export const findShift = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;
  for (const key of keys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const conditions = keys.map((k, idx) => `s.${k} = $${idx + 1}`).join(" AND ");
  const values = Object.values(filters);

  const [row] = await dbQuery(
    `SELECT s.* FROM ${TABLE} s WHERE ${conditions} LIMIT 1`,
    values
  );
  return row ?? null;
};

export const insertShift = async (data = {}) => {
  const { code, start_time, end_time, is_active = true } = data;
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (code, start_time, end_time, is_active)
     VALUES ($1, $2::time, $3::time, $4)
     RETURNING *`,
    [code, start_time, end_time, !!is_active]
  );
  return row;
};

export const updateShift = async (fields = {}, filters = {}) => {
  const fieldKeys = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length || !filterKeys.length) throw new Error("No fields or filters");

  for (const key of fieldKeys) assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const setParts = fieldKeys.map((k, idx) => {
    if (k === "start_time" || k === "end_time") return `${k} = $${idx + 1}::time`;
    return `${k} = $${idx + 1}`;
  });
  const setClause = setParts.join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const values = [...Object.values(fields), ...Object.values(filters)];

  return await dbQuery(
    `UPDATE ${TABLE} SET ${setClause} WHERE ${whereClause} RETURNING *`,
    values
  );
};

export const deleteShift = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) throw new Error("No filters");
  for (const key of keys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const conditions = keys.map((k, idx) => `${k} = $${idx + 1}`).join(" AND ");
  const values = Object.values(filters);

  return await dbQuery(`DELETE FROM ${TABLE} WHERE ${conditions} RETURNING *`, values);
};
