import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { MST_TABLES, ENGINEERING_TABLES } from "../../../../../config/db/dbTables.js";
import { findUserPermissions, findUserAppAccess } from "../../permissions/models/permission.model.js";
import { mergePermissionLists, normalizeAttributePermissions } from "../../permissions/utils/effectivePermissions.js";
import { cleanPermissionMap } from "../../../lib/utils/helper/helper.js";
import { moduleSortOrderNumericExpr } from "../../../lib/utils/config/moduleSortOrderSql.js";

const TABLE = MST_TABLES.ATTRIBUTES;
const USERS_TABLE = MST_TABLES.USERS;
const MACHINE_TABLE = ENGINEERING_TABLES.MACHINE_MASTER;
const MODULES_TABLE = MST_TABLES.MODULES;
const MODULE_SORT_ORDER = moduleSortOrderNumericExpr("m");

export const ATTRIBUTE_NAME_MAX_LENGTH = 100;

const ALLOWED_SELECT_FIELDS = ["id", "name", "permissions", "created_at", "updated_at"];
const ALLOWED_FILTER_FIELDS = ["id", "name", "from_date", "to_date"];
const ALLOWED_UPDATE_FIELDS = ["name", "permissions"];
const ALLOWED_SORT_FIELDS   = ["id", "name", "created_at"];

const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

export const normalizeAttributeName = (raw) => String(raw ?? "").replace(/\s+/g, " ").trim();

const mapAttributeRow = (row) => {
  if (!row) return null;
  return {
    ...row,
    permissions: normalizeAttributePermissions(row.permissions),
  };
};

export const findAttributes = async (options = {}) => {
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
    ? fields.filter(f => ALLOWED_SELECT_FIELDS.includes(f)).map(f => `a.${f}`)
    : ALLOWED_SELECT_FIELDS.map(f => `a.${f}`);
  const safeFields = mappedSelect.join(", ");

  const conditions = ["a.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (key === "from_date") {
      values.push(val);
      conditions.push(`a.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`a.created_at <= $${i++}`);
      continue;
    }
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
    values.push(val);
    conditions.push(`a.${key} = $${i++}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`a.name ILIKE $${i++}`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const rawSortBy = sort.by || "name";
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(rawSortBy) ? rawSortBy : "name";
  const safeSortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  const safePage  = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, parseInt(limit) || 10));
  const offset    = (safePage - 1) * safeLimit;

  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} a ${whereClause}`,
    [...values]
  );

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT ${safeFields} FROM ${TABLE} a
     ${whereClause}
     ORDER BY a.${safeSortBy} ${safeSortOrder}
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  return {
    data: rows.map(mapAttributeRow),
    total: parseInt(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(parseInt(count) / safeLimit),
  };
};

export const findAttribute = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;
  for (const key of keys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const conditions = keys.map((k, idx) => `a.${k} = $${idx + 1}`).join(" AND ");
  const [row] = await dbQuery(
    `SELECT a.id, a.name, a.permissions, a.created_at, a.updated_at FROM ${TABLE} a
     WHERE ${conditions} AND a.is_deleted = false LIMIT 1`,
    Object.values(filters)
  );
  return mapAttributeRow(row);
};

/** Returns null when an active attribute with the same name (case-insensitive) already exists. */
export const insertAttribute = async ({ name, permissions = [] }) => {
  const perms = normalizeAttributePermissions(permissions);
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (name, permissions) VALUES ($1, $2::jsonb)
     ON CONFLICT ((LOWER(name))) DO UPDATE SET
       is_deleted = false,
       name = EXCLUDED.name,
       permissions = EXCLUDED.permissions,
       updated_at = CURRENT_TIMESTAMP
       WHERE ${TABLE}.is_deleted = true
     RETURNING id, name, permissions, created_at, updated_at`,
    [name, JSON.stringify(perms)]
  );
  return mapAttributeRow(row);
};

export const updateAttribute = async (fields = {}, filters = {}) => {
  const fieldKeys  = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length || !filterKeys.length) throw new Error("No fields or filters");

  for (const key of fieldKeys)  assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const values = [];
  const setParts = [];
  for (const key of fieldKeys) {
    values.push(key === "permissions" ? JSON.stringify(normalizeAttributePermissions(fields[key])) : fields[key]);
    setParts.push(key === "permissions" ? `${key} = $${values.length}::jsonb` : `${key} = $${values.length}`);
  }
  setParts.push("updated_at = CURRENT_TIMESTAMP");

  const whereClause = filterKeys.map((k) => {
    values.push(filters[k]);
    return `${k} = $${values.length}`;
  }).join(" AND ");

  const rows = await dbQuery(
    `UPDATE ${TABLE} SET ${setParts.join(", ")}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING id, name, permissions, created_at, updated_at`,
    values
  );
  return rows.map(mapAttributeRow);
};

/** Soft-delete and strip this attribute id from users + machines. */
export const softDeleteAttribute = async ({ id }) => {
  if (id == null) throw new Error("No filters");
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE ${TABLE} SET is_deleted = true, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_deleted = false
       RETURNING id, name`,
      [id]
    );
    if (!rows.length) return { deleted: [], affectedUserIds: [] };

    const { rows: users } = await client.query(
      `UPDATE ${USERS_TABLE}
       SET attribute_ids = array_remove(attribute_ids, $1::int),
           updated_at = CURRENT_TIMESTAMP
       WHERE $1::int = ANY(attribute_ids)
       RETURNING id`,
      [id]
    );
    await client.query(
      `UPDATE ${MACHINE_TABLE}
       SET attribute_ids = array_remove(attribute_ids, $1::int),
           updated_at = CURRENT_TIMESTAMP
       WHERE $1::int = ANY(attribute_ids)`,
      [id]
    );

    return {
      deleted: rows,
      affectedUserIds: users.map((u) => u.id),
    };
  });
};

export const findUserIdsWithAttribute = async (attributeId) => {
  if (attributeId == null) return [];
  const rows = await dbQuery(
    `SELECT id FROM ${USERS_TABLE}
     WHERE $1::int = ANY(attribute_ids) AND is_deleted = false`,
    [attributeId]
  );
  return rows.map((r) => r.id);
};

// ─── User ↔ attribute links ──────────────────────────────────────

/**
 * Request body `attributes` → `{ ids, names }`.
 * Items: number / `{ id }` = existing attribute, string / `{ name }` = pick-or-create by name.
 * Returns `undefined` when absent (leave links untouched), `null` when malformed.
 */
export const parseAttributeInput = (raw) => {
  if (raw === undefined) return undefined;
  if (raw === null) return { ids: [], names: [] };
  if (!Array.isArray(raw)) return null;

  const ids = new Set();
  const names = new Map();
  for (const item of raw) {
    const id = typeof item === "number" ? item : Number(item?.id);
    if (typeof item === "object" && item !== null && item.id != null && !Number.isInteger(id)) return null;
    if (Number.isInteger(id) && id > 0) {
      ids.add(id);
      continue;
    }
    const name = normalizeAttributeName(typeof item === "string" ? item : item?.name);
    if (!name) continue;
    if (name.length > ATTRIBUTE_NAME_MAX_LENGTH) return null;
    const key = name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
  }
  return { ids: [...ids], names: [...names.values()] };
};

export const findUserAttributes = async (userId, client = null) => {
  const sql = `SELECT a.id, a.name, a.permissions
               FROM ${USERS_TABLE} u
               JOIN ${TABLE} a ON a.id = ANY(u.attribute_ids) AND a.is_deleted = false
               WHERE u.id = $1
               ORDER BY a.name ASC`;
  const rows = client
    ? (await client.query(sql, [userId])).rows
    : await dbQuery(sql, [userId]);
  return rows.map(mapAttributeRow);
};

/** Expand stored attribute permission JSON into module-joined permission rows. */
export const findAttributePermissionRowsForUser = async (userId) => {
  const attrs = await findUserAttributes(userId);
  const flat = [];
  for (const attr of attrs) {
    for (const row of attr.permissions || []) flat.push(row);
  }
  if (!flat.length) return [];

  const moduleIds = [...new Set(flat.map((r) => Number(r.module_id)).filter(Number.isFinite))];
  if (!moduleIds.length) return [];

  const modules = await dbQuery(
    `SELECT m.id AS module_id, m.name AS module_name, m.label AS module_label,
            m.app_type AS module_app_type, m.is_active AS module_is_active
     FROM ${MODULES_TABLE} m
     WHERE m.id = ANY($1::int[])
     ORDER BY ${MODULE_SORT_ORDER} ASC, m.label ASC NULLS LAST, m.id ASC`,
    [moduleIds]
  );
  const byId = new Map(modules.map((m) => [Number(m.module_id), m]).filter(([id]) => Number.isFinite(id)));

  return flat
    .map((row) => {
      const mid = Number(row.module_id);
      const meta = Number.isFinite(mid) ? byId.get(mid) : null;
      if (!meta) return null;
      return {
        ...meta,
        can_view: !!row.can_view,
        can_view_days: Number(row.can_view_days) || 0,
        can_add: !!row.can_add,
        can_edit: !!row.can_edit,
        can_edit_days: Number(row.can_edit_days) || 0,
        can_delete: !!row.can_delete,
        can_authorize: !!row.can_authorize,
      };
    })
    .filter(Boolean);
};

const PLANNING_MODULE = "production_planning";

/**
 * Attribute user without manual Production Planning view → board only shows matching machines.
 * Manual module view (user_permissions.can_view) → full machine list.
 */
export const userAttributeMachineScope = async (userId) => {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return false;
  const [row] = await dbQuery(`SELECT attribute_ids FROM ${USERS_TABLE} WHERE id = $1 AND is_deleted = false`, [uid]);
  const ids = Array.isArray(row?.attribute_ids) ? row.attribute_ids.map(Number).filter((n) => n > 0) : [];
  if (!ids.length) return false;
  const direct = await findUserPermissions(uid);
  const hasManualView = (direct || []).some((p) => p.module_name === PLANNING_MODULE && !!p.can_view);
  return !hasManualView;
};

/**
 * Attribute-only shop-floor users (no manual Planning view checkbox):
 * grant Production Planning view so board/calendar opens; machine list stays attribute-scoped.
 * Requires stored Production app access — do not open Production for unrelated attributes.
 */
async function withAttributePlanningView(perms, userId) {
  if (!(await userAttributeMachineScope(userId))) return perms;
  const appAccess = await findUserAppAccess(userId);
  if (!appAccess?.production) return perms;

  const idx = perms.findIndex((p) => p.module_name === PLANNING_MODULE);
  if (idx >= 0) {
    if (perms[idx].can_view) return perms;
    const next = perms.slice();
    next[idx] = { ...next[idx], can_view: true };
    return next;
  }

  const [mod] = await dbQuery(
    `SELECT m.id AS module_id, m.name AS module_name, m.label AS module_label, m.app_type AS module_app_type, m.is_active AS module_is_active
     FROM ${MODULES_TABLE} m
     WHERE m.name = $1
     LIMIT 1`,
    [PLANNING_MODULE]
  );
  if (!mod) return perms;

  return [
    ...perms,
    cleanPermissionMap({
      ...mod,
      can_view: true,
      can_view_days: 0,
      can_add: false,
      can_edit: false,
      can_edit_days: 0,
      can_delete: false,
      can_authorize: false,
    }),
  ];
}

/** Effective permissions = direct user permissions merged with assigned attributes. */
export const getEffectivePermissions = async (userOrId) => {
  const userId = typeof userOrId === "object" && userOrId != null
    ? Number(userOrId.id ?? userOrId.user_id)
    : Number(userOrId);
  if (!Number.isFinite(userId) || userId <= 0) return [];

  const [direct, fromAttributes] = await Promise.all([
    findUserPermissions(userId),
    findAttributePermissionRowsForUser(userId),
  ]);

  const merged = mergePermissionLists(direct, fromAttributes).map(cleanPermissionMap);
  return withAttributePlanningView(merged, userId);
};

/** Resolve `{ ids, names }` → sorted attribute id list (creates/revives by name). */
async function resolveAttributeIds(client, { ids = [], names = [] } = {}) {
  const resolved = new Set();
  if (ids.length) {
    const { rows } = await client.query(
      `SELECT id FROM ${TABLE} WHERE id = ANY($1::int[]) AND is_deleted = false`,
      [ids]
    );
    rows.forEach((r) => resolved.add(r.id));
  }
  if (names.length) {
    await client.query(
      `INSERT INTO ${TABLE} (name)
       SELECT UNNEST($1::text[])
       ON CONFLICT ((LOWER(name))) DO UPDATE SET is_deleted = false
         WHERE ${TABLE}.is_deleted = true`,
      [names]
    );
    const { rows } = await client.query(
      `SELECT id FROM ${TABLE} WHERE LOWER(name) = ANY($1::text[])`,
      [names.map((n) => n.toLowerCase())]
    );
    rows.forEach((r) => resolved.add(r.id));
  }
  return [...resolved].sort((a, b) => a - b);
}

/** Replace the user's attribute set with `{ ids, names }` (from `parseAttributeInput`); new names are created. */
export const syncUserAttributes = async (userId, parsed = {}) =>
  withTransaction(async (client) => {
    const ids = await resolveAttributeIds(client, parsed);
    await client.query(`UPDATE ${USERS_TABLE} SET attribute_ids = $2::int[] WHERE id = $1`, [userId, ids]);
    return findUserAttributes(userId, client);
  });

export const findMachineAttributes = async (maccode, client = null) => {
  const sql = `SELECT a.id, a.name
               FROM ${MACHINE_TABLE} m
               JOIN ${TABLE} a ON a.id = ANY(m.attribute_ids) AND a.is_deleted = false
               WHERE m.maccode = $1
               ORDER BY a.name ASC`;
  const rows = client ? (await client.query(sql, [maccode])).rows : await dbQuery(sql, [maccode]);
  return rows || [];
};

/** Replace machine attribute_ids (same body shape as users). */
export const syncMachineAttributes = async (maccode, parsed = {}) =>
  withTransaction(async (client) => {
    const ids = await resolveAttributeIds(client, parsed);
    await client.query(
      `UPDATE ${MACHINE_TABLE} SET attribute_ids = $2::int[], updated_at = CURRENT_TIMESTAMP WHERE maccode = $1`,
      [maccode, ids]
    );
    return findMachineAttributes(maccode, client);
  });
