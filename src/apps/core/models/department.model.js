import dbQuery from "../../../config/db.js";
import { MST_TABLES } from "../../../config/dbTables.js";

const TABLE = MST_TABLES.DEPARTMENTS;

const ALLOWED_SELECT_FIELDS = ["id", "name", "created_at", "updated_at"];
const ALLOWED_FILTER_FIELDS = ["id", "name", "from_date", "to_date"];
const ALLOWED_UPDATE_FIELDS = ["name", "updated_at"];
const ALLOWED_SORT_FIELDS   = ["id", "name", "created_at"];

const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

export const findDepartments = async (options = {}) => {
  const {
    filters = {},
    fields  = [],
    sort    = {},
    page    = 1,
    limit   = 10,
    search  = null,
  } = options;

  const values = [];
  let i = 1;

  const mappedSelect = fields.length > 0
    ? fields.filter(f => ALLOWED_SELECT_FIELDS.includes(f)).map(f => `d.${f}`)
    : ["d.*"];
  const safeFields = mappedSelect.join(", ");

  const conditions = ["TRUE"];

  for (const [key, val] of Object.entries(filters)) {
    if (key === "from_date") {
      values.push(val);
      conditions.push(`d.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`d.created_at <= $${i++}`);
      continue;
    }
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
    values.push(val);
    conditions.push(`d.${key} = $${i++}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`d.name ILIKE $${i++}`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const rawSortBy = sort.by || "id";
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(rawSortBy) ? rawSortBy : "id";
  const safeSortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  const safePage  = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 10));
  const offset    = (safePage - 1) * safeLimit;

  const countValues = [...values];
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} d ${whereClause}`,
    countValues
  );

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT ${safeFields} FROM ${TABLE} d
     ${whereClause}
     ORDER BY d.${safeSortBy} ${safeSortOrder}
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

export const findDepartment = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;
  for (const key of keys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const conditions = keys.map((k, idx) => `d.${k} = $${idx + 1}`).join(" AND ");
  const values = Object.values(filters);

  const [row] = await dbQuery(
    `SELECT d.* FROM ${TABLE} d WHERE ${conditions} LIMIT 1`,
    values
  );
  return row ?? null;
};

export const insertDepartment = async (data = {}) => {
  const { name } = data;
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (name) VALUES ($1) RETURNING *`,
    [name]
  );
  return row;
};

export const updateDepartment = async (fields = {}, filters = {}) => {
  const fieldKeys  = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length || !filterKeys.length) throw new Error("No fields or filters");

  for (const key of fieldKeys)  assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const setClause   = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const values      = [...Object.values(fields), ...Object.values(filters)];

  return await dbQuery(
    `UPDATE ${TABLE} SET ${setClause} WHERE ${whereClause} RETURNING *`,
    values
  );
};

export const deleteDepartment = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) throw new Error("No filters");
  for (const key of keys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const conditions = keys.map((k, idx) => `${k} = $${idx + 1}`).join(" AND ");
  const values = Object.values(filters);

  return await dbQuery(`DELETE FROM ${TABLE} WHERE ${conditions} RETURNING *`, values);
};
