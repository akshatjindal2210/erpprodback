import dbQuery from "../../../../../config/db/db.js";
import { RECORD_TABLE as TABLE } from "../../../lib/config/tables/tables.js";

const ALLOWED_FILTER_FIELDS = ["record_id", "name", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["record_id", "name", "created_at", "updated_at", "approved_at"];
const ALLOWED_UPDATE_FIELDS = [
  "name", "notes", "approved", "approved_by", "approved_at", "updated_by", "updated_at",
];

const DEFAULT_FIELDS = [
  "r.record_id", "r.name", "r.notes",
  "r.approved", "r.approved_by", "r.approved_at",
  "r.created_by", "r.created_at",
  "r.updated_by", "r.updated_at",
  "r.deleted_by", "r.deleted_at",
  "r.created_by AS created_by_name",
  "r.updated_by AS updated_by_name",
  "r.deleted_by AS deleted_by_name",
  "r.approved_by AS approved_by_name",
];

export const findRecords = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10 } = options;
  const values = [];
  let i = 1;
  const conditions = ["r.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;
    if (key === "from_date") {
      values.push(val);
      conditions.push(`r.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`r.created_at <= $${i++}`);
      continue;
    }
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(val);
    conditions.push(`r.${key} = $${i++}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(r.name ILIKE $${i} OR COALESCE(r.notes, '') ILIKE $${i} OR r.created_by ILIKE $${i})`);
    i++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const [{ count }] = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} r ${where}`, values);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;
  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} r
     ${where}
     ORDER BY r.${sortByField} ${sortOrder}
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(count / safeLimit) || 1,
  };
};

export const findRecord = async (filters = {}) => {
  const values = [];
  let i = 1;
  const conditions = ["r.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(val);
    conditions.push(`r.${key} = $${i++}`);
  }

  if (conditions.length === 1) return null;

  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")} FROM ${TABLE} r WHERE ${conditions.join(" AND ")} LIMIT 1`,
    values
  );
  return row ?? null;
};

export const findRecordDuplicate = async ({ name, excludeId = null }) => {
  const values = [name];
  let sql = `SELECT record_id FROM ${TABLE} WHERE LOWER(name) = LOWER($1) AND is_deleted = false`;
  if (excludeId != null) {
    values.push(excludeId);
    sql += ` AND record_id <> $2`;
  }
  const [row] = await dbQuery(`${sql} LIMIT 1`, values);
  return row ?? null;
};

export const insertRecord = async ({ name, notes, created_by }) => {
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (name, notes, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [name, notes ?? null, created_by]
  );
  return row;
};

export const updateRecords = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};
  for (const k in fields) if (ALLOWED_UPDATE_FIELDS.includes(k)) safeFields[k] = fields[k];
  for (const k in filters) if (ALLOWED_FILTER_FIELDS.includes(k)) safeFilters[k] = filters[k];

  const fieldKeys = Object.keys(safeFields);
  const filterKeys = Object.keys(safeFilters);
  if (!fieldKeys.length) throw new Error("No valid fields to update");
  if (!filterKeys.length) throw new Error("No valid filters provided");

  const values = [...Object.values(safeFields), ...Object.values(safeFilters)];
  const setClause = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const whereClause = filterKeys.map((k, i) => `${k} = $${fieldKeys.length + i + 1}`).join(" AND ");

  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setClause} WHERE ${whereClause} RETURNING *`,
    values
  );
  return row;
};

export const deleteRecords = async (filters = {}, meta = {}) => {
  const conditions = [];
  const values = [];
  let i = 1;
  for (const k of Object.keys(filters)) {
    if (!ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }
  if (!conditions.length) throw new Error("Invalid filters");
  values.push(meta.deleted_by ?? null);
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`,
    values
  );
};
