import dbQuery from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../config/db/dbTables.js";

const ALLOWED_FILTER_FIELDS = ["id", "process_id", "number", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = [
  "id", "name", "number", "process_id", "speed", "duration",
  "approved", "created_at", "updated_at",
];
const ALLOWED_UPDATE_FIELDS = [
  "name", "number", "process_id", "speed", "duration", "make", "model", "remark", "attachments",
  "approved", "approved_by", "approved_at", "updated_by", "updated_at",
];

const JOINS = `
  LEFT JOIN ${T.PROCESS_MASTER} pm ON pm.id = mm.process_id AND pm.is_deleted = false
`;

const DEFAULT_FIELDS = [
  "mm.id", "mm.name", "mm.number", "mm.process_id",
  "mm.speed", "mm.duration", "mm.make", "mm.model", "mm.remark",
  "COALESCE(mm.attachments, '[]'::jsonb) AS attachments",
  "pm.name AS process_name", "pm.type AS process_type",
  "mm.approved", "mm.approved_by", "mm.approved_at",
  "mm.created_by", "mm.created_at", "mm.updated_by", "mm.updated_at",
  "mm.deleted_by", "mm.deleted_at",
  "mm.created_by AS created_by_name",
  "mm.updated_by AS updated_by_name",
  "mm.approved_by AS approved_by_name",
  "mm.deleted_by AS deleted_by_name",
];

export { DEFAULT_FIELDS as MACHINE_DEFAULT_FIELDS };

export const findMachines = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [] } = options;
  const values = [];
  let i = 1;
  const conditions = ["mm.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`mm.created_at::date >= $${i++}::date`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`mm.created_at::date <= $${i++}::date`);
      continue;
    }
    if (key === "approved") {
      values.push(val === true || val === "true" || val === "1");
      conditions.push(`mm.approved = $${i++}`);
      continue;
    }
    values.push(val);
    conditions.push(`mm.${key} = $${i++}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(mm.name ILIKE $${i} OR mm.number ILIKE $${i} OR COALESCE(mm.make,'') ILIKE $${i} OR COALESCE(mm.model,'') ILIKE $${i} OR COALESCE(pm.name,'') ILIKE $${i})`
    );
    i += 1;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const selectFields = fields.length ? fields : DEFAULT_FIELDS;
  const sortKey = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "id";
  const sortDir = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

  const countRes = await dbQuery(
    `SELECT COUNT(*)::int AS total FROM ${T.MACHINE_MASTER} mm ${JOINS} ${where}`,
    values
  );
  const total = Number(countRes[0]?.total ?? 0);

  const offset = Math.max(0, (Number(page) - 1) * Number(limit));
  values.push(Number(limit), offset);
  const rows = await dbQuery(
    `SELECT ${selectFields.join(", ")}
     FROM ${T.MACHINE_MASTER} mm
     ${JOINS}
     ${where}
     ORDER BY mm.${sortKey} ${sortDir}, mm.id DESC
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );
  return { data: rows, total };
};

export const findMachine = async ({ id }) => {
  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${T.MACHINE_MASTER} mm
     ${JOINS}
     WHERE mm.id = $1 AND mm.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return row || null;
};

export const findMachineByNumber = async ({ number, excludeId = null }) => {
  const values = [String(number).trim().toLowerCase()];
  let sql = `
    SELECT id, number FROM ${T.MACHINE_MASTER}
    WHERE is_deleted = false AND lower(trim(number)) = $1
  `;
  if (excludeId) {
    values.push(excludeId);
    sql += ` AND id <> $2`;
  }
  sql += ` LIMIT 1`;
  const [row] = await dbQuery(sql, values);
  return row || null;
};

export const insertMachine = async (fields) => {
  const cols = Object.keys(fields);
  const vals = cols.map((key) =>
    key === "attachments" ? JSON.stringify(fields[key] ?? []) : fields[key]
  );
  const placeholders = cols.map((_, idx) => `$${idx + 1}`);
  const [row] = await dbQuery(
    `INSERT INTO ${T.MACHINE_MASTER} (${cols.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING *`,
    vals
  );
  return row;
};

export const updateMachines = async (fields, where) => {
  const setParts = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    if (!ALLOWED_UPDATE_FIELDS.includes(key)) continue;
    setParts.push(`${key} = $${i++}`);
    values.push(key === "attachments" ? JSON.stringify(val ?? []) : val);
  }
  if (!setParts.length) return null;

  const whereParts = [];
  for (const [key, val] of Object.entries(where)) {
    whereParts.push(`${key} = $${i++}`);
    values.push(val);
  }
  const [row] = await dbQuery(
    `UPDATE ${T.MACHINE_MASTER}
     SET ${setParts.join(", ")}
     WHERE ${whereParts.join(" AND ")} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row || null;
};

export const deleteMachines = async (where, audit = {}) => {
  const values = [];
  let i = 1;
  const whereParts = [];
  for (const [key, val] of Object.entries(where)) {
    whereParts.push(`${key} = $${i++}`);
    values.push(val);
  }
  values.push(audit.deleted_by ?? null);
  const [row] = await dbQuery(
    `UPDATE ${T.MACHINE_MASTER}
     SET is_deleted = true, deleted_by = $${i++}, deleted_at = NOW()
     WHERE ${whereParts.join(" AND ")} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row || null;
};
