import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { PORTAL_APP_KEYS } from "../../../config/portalModules.js";
import { moduleSortOrderNumericExpr } from "../../core/utils/moduleSortOrderSql.js";
import { APP_GATES, SETTINGS_MODULES } from "../../../config/portalModules.js";

const MODULE_SORT_ORDER = moduleSortOrderNumericExpr("m");

export const findUserPermissions = async (user_id) => {
  return await dbQuery(
    `SELECT 
       up.module_id,
       m.name  AS module_name,
       m.label AS module_label,
       m.app_type AS module_app_type,
       m.is_active AS module_is_active,
       up.can_view,
       up.can_view_days,
       up.can_add,
       up.can_edit,
       up.can_edit_days,
       up.can_delete,
       up.can_authorize 
     FROM ${M.USER_PERMISSIONS} up
     JOIN ${M.MODULES} m ON m.id = up.module_id
     WHERE up.user_id = $1
       AND up.is_deleted = false
     ORDER BY ${MODULE_SORT_ORDER} ASC, m.label ASC NULLS LAST, m.id ASC`,
    [user_id]
  );
};

export const findUserAppAccess = async (user_id) => {
  const rows = await dbQuery(
    `SELECT app_key, can_access FROM ${M.USER_APP_ACCESS} WHERE user_id = $1`,
    [user_id]
  );
  const out = Object.fromEntries(PORTAL_APP_KEYS.map((k) => [k, false]));
  for (const r of rows) {
    if (PORTAL_APP_KEYS.includes(r.app_key)) {
      out[r.app_key] = r.can_access === true;
    }
  }
  return out;
};

export const upsertAppAccess = async (user_id, app_key, can_access, meta = {}) => {
  const { updated_by } = meta;
  await dbQuery(
    `INSERT INTO ${M.USER_APP_ACCESS} (user_id, app_key, can_access)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, app_key)
     DO UPDATE SET can_access = $3, updated_at = NOW()`,
    [user_id, app_key, can_access]
  );
};

export const upsertBulkAppAccess = async (user_id, app_access = {}, meta = {}) => {
  for (const [app_key, can_access] of Object.entries(app_access)) {
    await upsertAppAccess(user_id, app_key, !!can_access, meta);
  }
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
     FROM ${M.USER_PERMISSIONS} up
     JOIN ${M.MODULES} m ON m.id = up.module_id
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
     FROM ${M.USER_PERMISSIONS} up
     JOIN ${M.MODULES} m ON m.id = up.module_id
     ${whereClause}
     ORDER BY ${sortBy} ${order}
     LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}`,
    dataValues
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const findPermission = async (user_id, module_id) => {
  const [permission] = await dbQuery(
    `SELECT * FROM ${M.USER_PERMISSIONS} 
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
     FROM ${M.USER_PERMISSIONS} up
     JOIN ${M.MODULES} m ON m.id = up.module_id
     WHERE up.id = $1 AND up.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return permission ?? null;
};

export const upsertPermission = async (user_id, module_id, actions = {}, meta = {}) => {
  const {
    can_view      = false,
    can_view_days = 0,
    can_add       = false,
    can_edit      = false,
    can_edit_days = 0,
    can_delete    = false,
    can_authorize = false,
  } = actions;
  const { created_by, updated_by } = meta;

  // 1. Check if record exists
  const [existing] = await dbQuery(
    `SELECT id FROM ${M.USER_PERMISSIONS} WHERE user_id = $1 AND module_id = $2`,
    [user_id, module_id]
  );

  if (existing) {
    // 2. Update existing (No ID wasted)
    const [permission] = await dbQuery(
      `UPDATE ${M.USER_PERMISSIONS} SET
         can_view      = $1,
         can_view_days = $2,
         can_add       = $3,
         can_edit      = $4,
         can_edit_days = $5,
         can_delete    = $6,
         can_authorize = $7,
         updated_by    = $8,
         is_deleted    = false,
         deleted_at    = NULL,
         deleted_by    = NULL
       WHERE id = $9
       RETURNING *`,
      [can_view, can_view_days, can_add, can_edit, can_edit_days, can_delete, can_authorize, updated_by, existing.id]
    );
    return permission;
  } else {
    // 3. Insert new (ID generated only now)
    const [permission] = await dbQuery(
      `INSERT INTO ${M.USER_PERMISSIONS} 
        (user_id, module_id, can_view, can_view_days, can_add, can_edit, can_edit_days, can_delete, can_authorize, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [user_id, module_id, can_view, can_view_days, can_add, can_edit, can_edit_days, can_delete, can_authorize, created_by]
    );
    return permission;
  }
};

export const upsertBulkPermissions = async (user_id, permissions = [], meta = {}) => {
  const results = [];
  for (const perm of permissions) {
    const result = await upsertPermission(user_id, perm.module_id, perm, meta);
    results.push(result);
  }
  return results;
};

/**
 * After save: sync logic if needed.
 * Currently we keep granular permissions even if app gate is OFF (per user request).
 */
export const syncAppGateChildPermissions = async (user_id, app_access = {}, meta = {}) => {
  // No-op: permissions persist even if app is disabled.
};

export const deletePermission = async (user_id, module_id, meta = {}) => {
  const { deleted_by } = meta;
  await dbQuery(
    `UPDATE ${M.USER_PERMISSIONS} 
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
    `UPDATE ${M.USER_PERMISSIONS}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE id = $1 AND is_deleted = false
     RETURNING *`,
    [id, deleted_by]
  );
  return row ?? null;
};
