/**
 * All SQL of Process Master — plain SELECT / INSERT / UPDATE only.
 * Stored: parent_id + depth. The path ("A > B > C") is added in JS from the tree (utils/processTree.js).
 */
import dbQuery from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../config/db/dbTables.js";
import { pathLabel, levelOf } from "../utils/processTree.js";

const TABLE = T.PROCESS_MASTER;

const BOOL_FILTERS = new Set(["approved", "fg", "prime", "multi_jc", "rm_wire", "tooling", "rework"]);

const FILTERS = {
  id: (i) => `pm.id = $${i}`,
  parent_id: (i) => `pm.parent_id = $${i}`,
  stage: (i) => `pm.stage = $${i}`,
  depth: (i) => `pm.depth = $${i}`,
  approved: (i) => `pm.approved = $${i}`,
  fg: (i) => `pm.fg = $${i}`,
  prime: (i) => `pm.prime = $${i}`,
  multi_jc: (i) => `pm.multi_jc = $${i}`,
  rm_wire: (i) => `pm.rm_wire = $${i}`,
  tooling: (i) => `pm.tooling = $${i}`,
  rework: (i) => `pm.rework = $${i}`,
  from_date: (i) => `pm.created_at::date >= $${i}::date`,
  to_date: (i) => `pm.created_at::date <= $${i}::date`,
};
const SORTS = ["id", "name", "stage", "depth", "parent_id", "approved", "created_at", "updated_at"];
const UPDATABLE = [
  "name", "parent_id", "depth", "stage", "multi_jc", "pattern",
  "rm_wire", "tooling", "fg", "prime", "rework",
  "approved", "approved_by", "approved_at", "updated_by", "updated_at",
];

const DEFAULT_FIELDS = [
  "pm.id", "pm.name", "pm.depth", "pm.parent_id", "pm.stage",
  "pm.multi_jc", "pm.pattern",
  "pm.rm_wire", "pm.tooling", "pm.fg", "pm.prime", "pm.rework",
  "parent.name AS parent_name",
  "pm.approved", "pm.approved_by", "pm.approved_at",
  "pm.created_by", "pm.created_at", "pm.updated_by", "pm.updated_at",
  "pm.deleted_by", "pm.deleted_at",
  "pm.created_by AS created_by_name",
  "pm.updated_by AS updated_by_name",
  "pm.approved_by AS approved_by_name",
  "pm.deleted_by AS deleted_by_name",
];

export { DEFAULT_FIELDS as PROCESS_DEFAULT_FIELDS };

const FROM = `FROM ${TABLE} pm LEFT JOIN ${TABLE} parent ON parent.id = pm.parent_id AND parent.is_deleted = false`;

/** All active processes as a tree (Map id → { id, name, parent_id, depth }). */
export async function loadTree() {
  const rows = await dbQuery(`SELECT id, name, parent_id, depth FROM ${TABLE} WHERE is_deleted = false`);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Adds `path_label` ("A > B > C") to each row. */
async function withPath(rows) {
  if (!rows.length) return rows;
  const tree = await loadTree();
  return rows.map((r) => ({ ...r, path_label: pathLabel(tree, r.id) || r.name }));
}

/** List with filters / search / sort / paging. `excludeIds` = ids to leave out (parent picker). */
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
  if (search) add(`%${search}%`, (i) => `(pm.name ILIKE $${i} OR parent.name ILIKE $${i} OR COALESCE(pm.pattern, '') ILIKE $${i})`);
  if (excludeIds.length) add(excludeIds, (i) => `pm.id <> ALL($${i}::int[])`);

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const [{ total }] = await dbQuery(`SELECT COUNT(*)::int AS total ${FROM} ${whereSql}`, values);

  const sortCol = SORTS.includes(sort.by) ? sort.by : "id";
  const sortDir = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const offset = Math.max(0, (Number(page) - 1) * Number(limit));
  const rows = await dbQuery(
    `SELECT ${(fields.length ? fields : DEFAULT_FIELDS).join(", ")} ${FROM} ${whereSql}
     ORDER BY pm.${sortCol} ${sortDir}, pm.id DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, Number(limit), offset]
  );
  return { data: await withPath(rows), total };
}

export async function findProcess(id) {
  const rows = await dbQuery(`SELECT ${DEFAULT_FIELDS.join(", ")} ${FROM} WHERE pm.id = $1 AND pm.is_deleted = false`, [id]);
  return (await withPath(rows))[0] ?? null;
}

/** Active process with the same name (case / spaces ignored) under the same parent, other than `exceptId`. */
export async function findSiblingByName(name, parentId, exceptId = null) {
  const [row] = await dbQuery(
    `SELECT pm.id, parent.name AS parent_name
       FROM ${TABLE} pm LEFT JOIN ${TABLE} parent ON parent.id = pm.parent_id
      WHERE pm.is_deleted = false AND pm.parent_id IS NOT DISTINCT FROM $2::int
        AND lower(trim(pm.name)) = lower(trim($1)) AND pm.id IS DISTINCT FROM $3::int
      LIMIT 1`,
    [name, parentId ?? null, exceptId ?? null]
  );
  return row ?? null;
}

export async function countActiveChildren(id) {
  const [row] = await dbQuery(`SELECT COUNT(*)::int AS c FROM ${TABLE} WHERE parent_id = $1 AND is_deleted = false`, [id]);
  return row?.c ?? 0;
}

export async function insertProcess(fields) {
  const cols = Object.keys(fields);
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(fields)
  );
  return row;
}

export async function updateProcess(id, fields) {
  const cols = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (!cols.length) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}
     WHERE id = $1 AND is_deleted = false RETURNING id`,
    [id, ...cols.map((k) => fields[k])]
  );
  return row ?? null;
}

export async function softDeleteProcess(id, deletedBy) {
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET is_deleted = true, deleted_by = $2, deleted_at = NOW()
     WHERE id = $1 AND is_deleted = false RETURNING id`,
    [id, deletedBy ?? null]
  );
  return row ?? null;
}

/** Fix `depth` of every process whose stored level is wrong (after a move, and once on boot). */
export async function syncProcessDepth() {
  const tree = await loadTree();
  for (const node of tree.values()) {
    const level = levelOf(tree, node.id);
    if (Number(node.depth) !== level) {
      await dbQuery(`UPDATE ${TABLE} SET depth = $2 WHERE id = $1`, [node.id, level]);
    }
  }
}
