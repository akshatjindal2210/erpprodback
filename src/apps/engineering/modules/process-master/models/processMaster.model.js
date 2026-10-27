/**
 * All SQL of Process Master — plain SELECT / INSERT / UPDATE only.
 * DB + API: proccode, procname. Stored: parent_id + depth. Path from utils/processTree.js.
 */
import dbQuery from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../config/db/dbTables.js";
import { pathLabel, levelOf } from "../utils/processTree.js";

const TABLE = T.PROCESS_MASTER;

/**
 * Boolean process options — single list. New flag: add name here + DB column in process_master.table.js.
 */
export const PROCESS_FLAGS = ["multi_jc", "rm_wire", "tooling", "fg", "prime", "rework", "inhouse", "jobwork"];

/** Row → { multi_jc: true, rm_wire: false, … } — exactly as set in Process Master. */
export const flagsOf = (row) => Object.fromEntries(PROCESS_FLAGS.map((f) => [f, row?.[f] === true]));

const BOOL_FILTERS = new Set(["approved", ...PROCESS_FLAGS]);

const FILTERS = {
  proccode: (i) => `pm.proccode = $${i}`,
  id: (i) => `pm.proccode = $${i}`,
  parent_id: (i) => `pm.parent_id = $${i}`,
  stage: (i) => `pm.stage = $${i}`,
  depth: (i) => `pm.depth = $${i}`,
  approved: (i) => `pm.approved = $${i}`,
  ...Object.fromEntries(PROCESS_FLAGS.map((f) => [f, (i) => `pm.${f} = $${i}`])),
  from_date: (i) => `pm.created_at::date >= $${i}::date`,
  to_date: (i) => `pm.created_at::date <= $${i}::date`,
};
const SORTS = ["proccode", "procname", "id", "name", "stage", "depth", "parent_id", "approved", "created_at", "updated_at"];
const SORT_COL = { proccode: "proccode", procname: "procname", id: "proccode", name: "procname" };
const UPDATABLE = [
  "procname", "parent_id", "depth", "stage", "pattern",
  ...PROCESS_FLAGS,
  "approved", "approved_by", "approved_at", "updated_by", "updated_at",
];

const DEFAULT_FIELDS = [
  "pm.proccode", "pm.procname", "pm.depth", "pm.parent_id", "pm.stage",
  "pm.pattern",
  ...PROCESS_FLAGS.map((f) => `pm.${f}`),
  "parent.procname AS parent_name",
  "pm.approved", "pm.approved_by", "pm.approved_at",
  "pm.created_by", "pm.created_at", "pm.updated_by", "pm.updated_at",
  "pm.deleted_by", "pm.deleted_at",
  "pm.created_by AS created_by_name",
  "pm.updated_by AS updated_by_name",
  "pm.approved_by AS approved_by_name",
  "pm.deleted_by AS deleted_by_name",
];

export { DEFAULT_FIELDS as PROCESS_DEFAULT_FIELDS };

const FROM = `FROM ${TABLE} pm LEFT JOIN ${TABLE} parent ON parent.proccode = pm.parent_id AND parent.is_deleted = false`;

/** API / write fields → DB columns. */
function toDbFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "procname" || k === "name") out.procname = v;
    else if (k === "proccode" || k === "id") out.proccode = v;
    else out[k] = v;
  }
  return out;
}

/** All active processes as a tree (Map proccode → { proccode, procname, parent_id, depth }). */
export async function loadTree() {
  const rows = await dbQuery(
    `SELECT proccode, procname, parent_id, depth FROM ${TABLE} WHERE is_deleted = false`
  );
  return new Map(rows.map((r) => [r.proccode, r]));
}

/** Adds `path_label` ("A > B > C") to each row. */
async function withPath(rows) {
  if (!rows.length) return rows;
  const tree = await loadTree();
  return rows.map((r) => ({ ...r, path_label: pathLabel(tree, r.proccode) || r.procname }));
}

/** List with filters / search / sort / paging. `excludeIds` = codes to leave out (parent picker). */
export async function findProcesses({ filters = {}, search, sort = {}, page = 1, limit = 10, fields = [], excludeIds = [] } = {}) {
  const values = [];
  const where = ["pm.is_deleted = false"];
  const add = (val, sql) => {
    values.push(val);
    where.push(sql(values.length));
  };

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "" || !FILTERS[key]) continue;
    const next = BOOL_FILTERS.has(key) ? val === true || val === "true" || val === "1" : val;
    add(next, FILTERS[key]);
  }
  if (search) {
    add(
      `%${search}%`,
      (i) => `(pm.procname ILIKE $${i} OR parent.procname ILIKE $${i} OR COALESCE(pm.pattern, '') ILIKE $${i})`
    );
  }
  if (excludeIds.length) add(excludeIds, (i) => `pm.proccode <> ALL($${i}::int[])`);

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const [{ total }] = await dbQuery(`SELECT COUNT(*)::int AS total ${FROM} ${whereSql}`, values);

  const sortKey = SORTS.includes(sort.by) ? sort.by : "proccode";
  const sortCol = SORT_COL[sortKey] || sortKey;
  const sortDir = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const offset = Math.max(0, (Number(page) - 1) * Number(limit));
  const rows = await dbQuery(
    `SELECT ${(fields.length ? fields : DEFAULT_FIELDS).join(", ")} ${FROM} ${whereSql}
     ORDER BY pm.${sortCol} ${sortDir}, pm.proccode DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, Number(limit), offset]
  );
  return { data: await withPath(rows), total };
}

export async function findProcess(proccode) {
  const rows = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")} ${FROM} WHERE pm.proccode = $1 AND pm.is_deleted = false`,
    [proccode]
  );
  return (await withPath(rows))[0] ?? null;
}

/** Active process with the same name under the same parent, other than `exceptCode`. */
export async function findSiblingByName(procname, parentId, exceptCode = null) {
  const [row] = await dbQuery(
    `SELECT pm.proccode, parent.procname AS parent_name
       FROM ${TABLE} pm LEFT JOIN ${TABLE} parent ON parent.proccode = pm.parent_id
      WHERE pm.is_deleted = false AND pm.parent_id IS NOT DISTINCT FROM $2::int
        AND lower(trim(pm.procname)) = lower(trim($1)) AND pm.proccode IS DISTINCT FROM $3::int
      LIMIT 1`,
    [procname, parentId ?? null, exceptCode ?? null]
  );
  return row ?? null;
}

export async function countActiveChildren(proccode) {
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS c FROM ${TABLE} WHERE parent_id = $1`,
    [proccode]
  );
  return row?.c ?? 0;
}

/** Machines linked to this process (blocks hard delete). */
export async function countMachinesForProcess(proccode) {
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS c FROM ${T.MACHINE_MASTER} WHERE macproccode = $1`,
    [proccode]
  );
  return row?.c ?? 0;
}

export async function insertProcess(fields) {
  const db = toDbFields(fields);
  const cols = Object.keys(db);
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING proccode`,
    Object.values(db)
  );
  return row;
}

export async function updateProcess(proccode, fields) {
  const cols = Object.keys(fields).filter((k) => UPDATABLE.includes(k) || k === "name");
  if (!cols.length) return null;
  const db = toDbFields(Object.fromEntries(cols.map((k) => [k, fields[k]])));
  const dbCols = Object.keys(db);
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${dbCols.map((k, i) => `${k} = $${i + 2}`).join(", ")}
     WHERE proccode = $1 AND is_deleted = false RETURNING proccode`,
    [proccode, ...Object.values(db)]
  );
  return row ?? null;
}

/** Hard delete — row removed from DB. */
export async function softDeleteProcess(proccode) {
  const [row] = await dbQuery(
    `DELETE FROM ${TABLE} WHERE proccode = $1 RETURNING proccode`,
    [proccode]
  );
  return row ?? null;
}

/** Fix `depth` of every process whose stored level is wrong (after a move, and once on boot). */
export async function syncProcessDepth() {
  const tree = await loadTree();
  for (const node of tree.values()) {
    const level = levelOf(tree, node.proccode);
    if (Number(node.depth) !== level) {
      await dbQuery(`UPDATE ${TABLE} SET depth = $2 WHERE proccode = $1`, [node.proccode, level]);
    }
  }
}
