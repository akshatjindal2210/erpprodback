import dbQuery from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../config/db/dbTables.js";

const ALLOWED_FILTER_FIELDS = ["id", "type", "parent_id", "stage", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["id", "name", "type", "stage", "parent_id", "approved", "created_at", "updated_at", "path_label"];
const ALLOWED_UPDATE_FIELDS = [
  "name", "type", "parent_id", "stage", "multi_mc", "pattern",
  "approved", "approved_by", "approved_at", "updated_by", "updated_at",
];

const JOINS = `
  LEFT JOIN ${T.PROCESS_MASTER} parent ON parent.id = pm.parent_id AND parent.is_deleted = false
  LEFT JOIN ${T.PROCESS_MASTER} grand ON grand.id = parent.parent_id AND grand.is_deleted = false
`;

const PATH_SQL = `CASE
  WHEN grand.name IS NOT NULL THEN grand.name || ' > ' || parent.name || ' > ' || pm.name
  WHEN parent.name IS NOT NULL THEN parent.name || ' > ' || pm.name
  ELSE pm.name
END`;

const DEFAULT_FIELDS = [
  "pm.id", "pm.name", "pm.type", "pm.parent_id", "pm.stage",
  "pm.multi_mc", "pm.pattern",
  "parent.name AS parent_name", "parent.type AS parent_type",
  `${PATH_SQL} AS path_label`,
  "pm.approved", "pm.approved_by", "pm.approved_at",
  "pm.created_by", "pm.created_at", "pm.updated_by", "pm.updated_at",
  "pm.deleted_by", "pm.deleted_at",
  "pm.created_by AS created_by_name",
  "pm.updated_by AS updated_by_name",
  "pm.approved_by AS approved_by_name",
  "pm.deleted_by AS deleted_by_name",
];

export { DEFAULT_FIELDS as PROCESS_DEFAULT_FIELDS };

export const findProcesses = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [] } = options;
  const values = [];
  let i = 1;
  const conditions = ["pm.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`pm.created_at::date >= $${i++}::date`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`pm.created_at::date <= $${i++}::date`);
      continue;
    }
    if (key === "approved") {
      values.push(val === true || val === "true" || val === "1");
      conditions.push(`pm.approved = $${i++}`);
      continue;
    }
    values.push(val);
    conditions.push(`pm.${key} = $${i++}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(pm.name ILIKE $${i} OR parent.name ILIKE $${i} OR COALESCE(pm.pattern, '') ILIKE $${i})`);
    i += 1;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const selectFields = fields.length ? fields : DEFAULT_FIELDS;
  const sortKey = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "id";
  const sortDir = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const sortCol = sortKey === "path_label" ? "path_label" : `pm.${sortKey}`;

  const countRes = await dbQuery(
    `SELECT COUNT(*)::int AS total FROM ${T.PROCESS_MASTER} pm ${JOINS} ${where}`,
    values
  );
  const total = Number(countRes[0]?.total ?? 0);

  const offset = Math.max(0, (Number(page) - 1) * Number(limit));
  values.push(Number(limit), offset);
  const rows = await dbQuery(
    `SELECT ${selectFields.join(", ")}
     FROM ${T.PROCESS_MASTER} pm
     ${JOINS}
     ${where}
     ORDER BY ${sortCol} ${sortDir}, pm.id DESC
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );
  return { data: rows, total };
};

export const findProcess = async ({ id }) => {
  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${T.PROCESS_MASTER} pm
     ${JOINS}
     WHERE pm.id = $1 AND pm.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return row || null;
};

export const findStageConflict = async ({ stage, excludeId = null }) => {
  if (stage !== "START" && stage !== "END") return null;
  const values = [stage];
  let sql = `SELECT id, name, stage FROM ${T.PROCESS_MASTER} WHERE is_deleted = false AND stage = $1`;
  if (excludeId) {
    values.push(excludeId);
    sql += ` AND id <> $2`;
  }
  sql += ` LIMIT 1`;
  const [row] = await dbQuery(sql, values);
  return row || null;
};

export const insertProcess = async (fields) => {
  const cols = Object.keys(fields);
  const vals = Object.values(fields);
  const placeholders = cols.map((_, idx) => `$${idx + 1}`);
  const [row] = await dbQuery(
    `INSERT INTO ${T.PROCESS_MASTER} (${cols.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING *`,
    vals
  );
  return row;
};

export const updateProcesses = async (fields, where) => {
  const setParts = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    if (!ALLOWED_UPDATE_FIELDS.includes(key)) continue;
    setParts.push(`${key} = $${i++}`);
    values.push(val);
  }
  if (!setParts.length) return null;

  const whereParts = [];
  for (const [key, val] of Object.entries(where)) {
    whereParts.push(`${key} = $${i++}`);
    values.push(val);
  }
  const [row] = await dbQuery(
    `UPDATE ${T.PROCESS_MASTER}
     SET ${setParts.join(", ")}
     WHERE ${whereParts.join(" AND ")} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row || null;
};

export const deleteProcesses = async (where, audit = {}) => {
  const values = [];
  let i = 1;
  const whereParts = [];
  for (const [key, val] of Object.entries(where)) {
    whereParts.push(`${key} = $${i++}`);
    values.push(val);
  }
  values.push(audit.deleted_by ?? null);
  const [row] = await dbQuery(
    `UPDATE ${T.PROCESS_MASTER}
     SET is_deleted = true, deleted_by = $${i++}, deleted_at = NOW()
     WHERE ${whereParts.join(" AND ")} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row || null;
};

export const countActiveChildren = async (id) => {
  const rows = await dbQuery(
    `SELECT COUNT(*)::int AS c FROM ${T.PROCESS_MASTER}
     WHERE parent_id = $1 AND is_deleted = false`,
    [id]
  );
  return rows[0]?.c ?? 0;
};
