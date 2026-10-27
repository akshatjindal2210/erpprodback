import dbQuery from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../config/db/dbTables.js";
import { attachmentsFromDocuments, deactivateModuleDocuments } from "../../../../../lib/documents/index.js";

const MACHINE_MODULE = "eng_machine_master";

const ALLOWED_FILTER_FIELDS = ["maccode", "macproccode", "macno", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = [
  "maccode", "macname", "macno", "macproccode", "cavity", "maccycletime", "setup_time",
  "approved", "created_at", "updated_at",
];
const ALLOWED_UPDATE_FIELDS = [
  "macname", "macno", "macproccode", "cavity", "maccycletime", "setup_time", "make", "model", "remark",
  "approved", "approved_by", "approved_at", "updated_by", "updated_at",
];

const JOINS = `
  LEFT JOIN ${T.PROCESS_MASTER} pm ON pm.proccode = mm.macproccode AND pm.is_deleted = false
`;

const DEFAULT_FIELDS = [
  "mm.maccode", "mm.macname", "mm.macno", "mm.macproccode",
  "mm.cavity", "mm.maccycletime", "mm.setup_time", "mm.make", "mm.model", "mm.remark",
  `pm.procname AS process_name`, "pm.depth AS process_depth",
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
      `(mm.macname ILIKE $${i} OR mm.macno ILIKE $${i} OR COALESCE(mm.make,'') ILIKE $${i} OR COALESCE(mm.model,'') ILIKE $${i} OR COALESCE(pm.procname,'') ILIKE $${i})`
    );
    i += 1;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const selectFields = fields.length ? fields : DEFAULT_FIELDS;
  const sortKey = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "maccode";
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
     ORDER BY mm.${sortKey} ${sortDir}, mm.maccode DESC
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );
  return { data: rows, total };
};

export const findMachine = async ({ maccode, id }) => {
  const code = maccode ?? id;
  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${T.MACHINE_MASTER} mm
     ${JOINS}
     WHERE mm.maccode = $1 AND mm.is_deleted = false
     LIMIT 1`,
    [code]
  );
  if (!row) return null;
  const attachments = await attachmentsFromDocuments(MACHINE_MODULE, row.maccode, [], "machine");
  return { ...row, attachments };
};

/** Another active machine with the same `macname` or `macno` (values stored CAPS), other than `excludeId`. */
export const findMachineDuplicate = async (field, value, excludeId = null) => {
  if (!["macname", "macno"].includes(field)) return null;
  const [row] = await dbQuery(
    `SELECT maccode FROM ${T.MACHINE_MASTER}
     WHERE is_deleted = false AND ${field} = $1 AND maccode IS DISTINCT FROM $2::int
     LIMIT 1`,
    [String(value ?? "").trim().toUpperCase(), excludeId]
  );
  return row || null;
};

export const insertMachine = async (fields) => {
  const cols = Object.keys(fields);
  const vals = cols.map((key) => fields[key]);
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
    values.push(val);
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

/** Hard delete — row removed from DB. */
export const deleteMachines = async (where) => {
  const values = [];
  let i = 1;
  const whereParts = [];
  for (const [key, val] of Object.entries(where)) {
    whereParts.push(`${key} = $${i++}`);
    values.push(val);
  }
  if (where?.maccode != null) {
    await deactivateModuleDocuments(MACHINE_MODULE, where.maccode);
  }
  if (!whereParts.length) return null;
  const [row] = await dbQuery(
    `DELETE FROM ${T.MACHINE_MASTER} WHERE ${whereParts.join(" AND ")} RETURNING *`,
    values
  );
  return row || null;
};
