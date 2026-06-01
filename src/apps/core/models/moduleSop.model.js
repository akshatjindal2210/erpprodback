import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

const TABLE = M.MODULE_SOPS;

const ALLOWED_LIST_FILTER_FIELDS = ["id", "module_id", "permission_type", "is_required", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["id", "module_id", "permission_type", "is_required", "created_at", "updated_at"];
const ALLOWED_UPDATE_FIELDS = ["description", "is_required", "updated_by", "updated_at"];
const ALLOWED_FIND_KEYS = ["id", "module_id"];
const ALLOWED_DELETE_FILTER_KEYS = ["id"];

const MS_FROM = `FROM ${TABLE} ms
  LEFT JOIN ${M.USERS} u_cr ON ms.created_by = u_cr.id
  LEFT JOIN ${M.USERS} u_up ON ms.updated_by = u_up.id`;

const assertField = (key, list, ctx = "field") => {
  if (!list.includes(key)) throw new Error(`Invalid ${ctx}: "${key}"`);
};

export const findModuleSops = async ({
  filters = {},
  sort = { by: "id", order: "ASC" },
  page = 1,
  limit = 5000,
} = {}) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(10000, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (safePage - 1) * safeLimit;

  const rawSortBy = sort?.by || "id";
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(rawSortBy) ? rawSortBy : "id";
  const safeOrder = sort?.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  const values = [];
  let i = 1;
  const whereClauses = ["ms.is_deleted = false"];

  Object.keys(filters).forEach((key) => {
    const val = filters[key];
    if (val === undefined || val === null) return;
    if (!ALLOWED_LIST_FILTER_FIELDS.includes(key)) return;

    if (key === "from_date") {
      values.push(val);
      whereClauses.push(`ms.created_at >= $${i++}`);
      return;
    }
    if (key === "to_date") {
      values.push(val);
      whereClauses.push(`ms.created_at <= $${i++}`);
      return;
    }
    values.push(val);
    whereClauses.push(`ms.${key} = $${i++}`);
  });

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const countQuery = `SELECT COUNT(*)::int AS count ${MS_FROM} ${whereSql}`;
  const totalResult = await dbQuery(countQuery, values);
  const totalCount = parseInt(totalResult[0]?.count ?? 0, 10);

  const dataValues = [...values, safeLimit, offset];
  const limPh = `$${i++}`;
  const offPh = `$${i++}`;
  const dataQuery = `
    SELECT ms.*, u_cr.name AS created_by_name, u_up.name AS updated_by_name
    ${MS_FROM}
    ${whereSql}
    ORDER BY ms.${safeSortBy} ${safeOrder}
    LIMIT ${limPh} OFFSET ${offPh}
  `;

  const data = await dbQuery(dataQuery, dataValues);

  return {
    data,
    total_count: totalCount,
    current_page: safePage,
    last_page: Math.ceil(totalCount / safeLimit) || 1,
  };
};

export const findModuleSop = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (keys.length === 0) return null;
  for (const key of keys) assertField(key, ALLOWED_FIND_KEYS, "filter field");

  const conditions = keys.map((key, idx) => `ms.${key} = $${idx + 1}`).join(" AND ");
  const [row] = await dbQuery(
    `SELECT ms.*, u_cr.name AS created_by_name, u_up.name AS updated_by_name
     ${MS_FROM}
     WHERE ms.is_deleted = false AND ${conditions}
     LIMIT 1`,
    Object.values(filters)
  );
  return row ?? null;
};

/** One live SOP per module + permission_type */
export const findModuleSopByModulePermission = async (module_id, permission_type) => {
  const [row] = await dbQuery(
    `SELECT ms.*, u_cr.name AS created_by_name, u_up.name AS updated_by_name
     ${MS_FROM}
     WHERE ms.is_deleted = false AND ms.module_id = $1 AND ms.permission_type = $2
     LIMIT 1`,
    [module_id, permission_type]
  );
  return row ?? null;
};

export const insertModuleSop = async ({
  module_id,
  permission_type,
  description,
  is_required = false,
  created_by,
}) => {
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
      (module_id, permission_type, description, is_required, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [module_id, permission_type, description ?? null, !!is_required, created_by]
  );
  return row;
};

export const updateModuleSop = async (fields = {}, filters = {}) => {
  const fieldKeys = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (fieldKeys.length === 0 || filterKeys.length === 0) return null;
  for (const k of fieldKeys) assertField(k, ALLOWED_UPDATE_FIELDS, "update field");
  for (const k of filterKeys) assertField(k, ALLOWED_DELETE_FILTER_KEYS, "filter field");

  const setClause = fieldKeys.map((key, idx) => `${key} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((key, idx) => `${key} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const vals = [...Object.values(fields), ...Object.values(filters)];

  const [updated] = await dbQuery(
    `UPDATE ${TABLE} SET ${setClause} WHERE ${whereClause} AND is_deleted = false RETURNING *`,
    vals
  );
  return updated ?? null;
};

export const deleteModuleSop = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  if (keys.length === 0) throw new Error("No filters provided");
  for (const k of keys) assertField(k, ALLOWED_DELETE_FILTER_KEYS, "delete filter");

  const conditions = keys.map((key, idx) => `${key} = $${idx + 1}`).join(" AND ");
  await dbQuery(
    `UPDATE ${TABLE} SET is_deleted = true, deleted_at = NOW(), deleted_by = $${keys.length + 1}
     WHERE ${conditions} AND is_deleted = false`,
    [...Object.values(filters), meta.deleted_by ?? null]
  );
};
