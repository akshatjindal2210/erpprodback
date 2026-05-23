import dbQuery from "../config/db.js";
import { moduleSortOrderNumericExpr } from "../utils/moduleSortOrderSql.js";

const MODULE_SORT_ORDER = moduleSortOrderNumericExpr("m");

// ─── Get all permissions for a user ──────────────────────────────
export const findUserPermissions = async (user_id) => {
  return await dbQuery(
    `SELECT 
       up.module_id,
       m.name  AS module_name,
       m.label AS module_label,
       m.is_active AS module_is_active,
       up.can_view,
       up.can_view_days,
       up.can_add,
       up.can_edit,
       up.can_edit_days,
       up.can_delete,
       up.can_authorize 
     FROM user_permissions up
     JOIN modules m ON m.id = up.module_id
     WHERE up.user_id = $1
       AND up.is_deleted = false
     ORDER BY ${MODULE_SORT_ORDER} ASC, m.label ASC NULLS LAST, m.id ASC`,
    [user_id]
  );
};

export const findPermissions = async ({ filters = {}, search, sort = { by: "up.id", order: "DESC" }, page = 1, limit = 10 } = {}) => {
  const values = [];
  const conditions = ["up.is_deleted = false"];

  for (const [key, value] of Object.entries(filters)) {
    if (key === "from_date") {
      values.push(value);
      conditions.push(`up.created_at >= $${values.length}`);
      continue;
    }
    if (key === "to_date") {
      values.push(value);
      conditions.push(`up.created_at <= $${values.length}`);
      continue;
    }
    values.push(value);
    conditions.push(`up.${key} = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(m.name ILIKE $${values.length} OR m.label ILIKE $${values.length})`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (safePage - 1) * safeLimit;

  const countRows = await dbQuery(
    `SELECT COUNT(*) AS count
     FROM user_permissions up
     JOIN modules m ON m.id = up.module_id
     ${whereClause}`,
    values
  );
  const total = parseInt(countRows[0]?.count || 0, 10);

  const sortBy = ["up.id", "up.user_id", "up.module_id", "m.name", "m.label"].includes(sort.by) ? sort.by : "up.id";
  const order = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";

  const dataValues = [...values, safeLimit, offset];
  const rows = await dbQuery(
    `SELECT
       up.id,
       up.user_id,
       up.module_id,
       up.can_view,
       up.can_view_days,
       up.can_add,
       up.can_edit,
       up.can_edit_days,
       up.can_delete,
       up.can_authorize,
       m.name AS module_name,
       m.label AS module_label
     FROM user_permissions up
     JOIN modules m ON m.id = up.module_id
     ${whereClause}
     ORDER BY ${sortBy} ${order}
     LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}`,
    dataValues
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};
// ─── Get single permission for user + module ────────────────────
export const findPermission = async (user_id, module_id) => {
  const [permission] = await dbQuery(
    `SELECT * FROM user_permissions 
     WHERE user_id = $1 AND module_id = $2 AND is_deleted = false`,
    [user_id, module_id]
  );
  return permission ?? null;
};

export const findPermissionById = async (id) => {
  const [permission] = await dbQuery(
    `SELECT
       up.*,
       m.name AS module_name,
       m.label AS module_label
     FROM user_permissions up
     JOIN modules m ON m.id = up.module_id
     WHERE up.id = $1 AND up.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return permission ?? null;
};

// ─── Upsert single permission ───────────────────────────────────
export const upsertPermission = async (user_id, module_id, actions = {}, meta = {}) => {
  const {
    can_view      = false,
    can_view_days = 0,
    can_add       = false,
    can_edit      = false,
    can_edit_days = 0,
    can_delete    = false,
    can_authorize = false,  //  add kiya
  } = actions;
  const { created_by, updated_by } = meta;

  const [permission] = await dbQuery(
    `INSERT INTO user_permissions 
      (user_id, module_id, can_view, can_view_days, can_add, can_edit, can_edit_days, can_delete, can_authorize, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, module_id)
     DO UPDATE SET
       can_view      = $3,
       can_view_days = $4,
       can_add       = $5,
       can_edit      = $6,
       can_edit_days = $7,
       can_delete    = $8,
       can_authorize = $9,
       updated_by    = $11
     RETURNING *`,
    [user_id, module_id, can_view, can_view_days, can_add, can_edit, can_edit_days, can_delete, can_authorize, created_by, updated_by]
  );
  return permission;
};

// ─── Upsert bulk permissions ─────────────────────────────────────
export const upsertBulkPermissions = async (user_id, permissions = [], meta = {}) => {
  const results = [];
  for (const perm of permissions) {
    const result = await upsertPermission(user_id, perm.module_id, perm, meta);
    results.push(result);
  }
  return results;
};

// ─── Soft-delete permission ─────────────────────────────────────
export const deletePermission = async (user_id, module_id, meta = {}) => {
  const { deleted_by } = meta;
  await dbQuery(
    `UPDATE user_permissions 
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $3
     WHERE user_id = $1 AND module_id = $2`,
    [user_id, module_id, deleted_by]
  );
};

export const updatePermissionById = async (id, actions = {}, meta = {}) => {
  const existing = await findPermissionById(id);
  if (!existing) return null;
  return upsertPermission(existing.user_id, existing.module_id, actions, meta);
};

export const deletePermissionById = async (id, meta = {}) => {
  const { deleted_by } = meta;
  const [row] = await dbQuery(
    `UPDATE user_permissions
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE id = $1 AND is_deleted = false
     RETURNING *`,
    [id, deleted_by]
  );
  return row ?? null;
};