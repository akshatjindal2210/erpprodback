import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { moduleSortOrderNumericExpr } from "../utils/moduleSortOrderSql.js";

const ALLOWED_SELECT_FIELDS  = ["id", "name", "label", "app_type", "sort_order", "is_active", "created_at", "updated_at", "updated_by", "updated_by_name"];
const ALLOWED_FILTER_FIELDS  = ["id", "name", "label", "app_type", "sort_order", "is_active", "from_date", "to_date"];
const ALLOWED_UPDATE_FIELDS  = ["name", "label", "app_type", "sort_order", "is_active", "updated_by", "updated_at"];
const ALLOWED_SORT_FIELDS    = ["id", "name", "label", "app_type", "sort_order", "created_at", "is_active", "updated_at"];

const MODULE_SORT_ORDER_EXPR = moduleSortOrderNumericExpr("m");

const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

const MODULE_LIST_JOIN = `FROM ${M.MODULES} m LEFT JOIN ${M.USERS} u_up ON m.updated_by = u_up.id`;

const mapModuleSelectField = (f) => {
  if (f === "updated_by_name") return "u_up.name AS updated_by_name";
  return `m.${f}`;
};

const DEFAULT_MODULE_LIST_SELECT =
  "m.id, m.name, m.label, m.app_type, m.sort_order, m.is_active, m.created_at, m.updated_at, m.updated_by, u_up.name AS updated_by_name";

export const findModules = async (options = {}) => {
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

  // SELECT clause (join users for last status toggle / update name)
  const mappedFields = fields.length > 0
    ? fields.filter(f => ALLOWED_SELECT_FIELDS.includes(f)).map(mapModuleSelectField)
    : [];
  const safeFields = mappedFields.length > 0 ? mappedFields.join(", ") : DEFAULT_MODULE_LIST_SELECT;

  // WHERE clause (baseline so empty filter/search still yields valid SQL)
  const conditions = ["TRUE"];

  // Permission-based date restriction (can_view_days) bound param, capped (no string interpolation)
  const viewDays = Math.min(3650, Math.max(0, parseInt(options.permission?.can_view_days, 10) || 0));
  if (viewDays > 0) {
    values.push(Math.max(0, viewDays - 1));
    conditions.push(`m.created_at >= CURRENT_DATE - ($${i++} * INTERVAL '1 day')`);
  }

  for (const [key, val] of Object.entries(filters)) {
    if (key === "from_date") {
      values.push(val);
      conditions.push(`m.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`m.created_at <= $${i++}`);
      continue;
    }
    
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

    if (val === null) {
      conditions.push(`m.${key} IS NULL`);
    } else if (Array.isArray(val)) {
      const placeholders = val.map(() => `$${i++}`).join(", ");
      values.push(...val);
      conditions.push(`m.${key} IN (${placeholders})`);
    } else if (typeof val === "string" && val.includes("%")) {
      values.push(val);
      conditions.push(`m.${key} ILIKE $${i++}`);
    } else {
      values.push(val);
      conditions.push(`m.${key} = $${i++}`);
    }
  }

  // Search Logic (Parameterized)
  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(m.name ILIKE $${idx} OR m.label ILIKE $${idx})`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  // ORDER BY default: DB `sort_order` (manual), then label
  const rawSortBy =
    sort.by != null && String(sort.by).trim() !== "" ? String(sort.by).trim() : "sort_order";
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(rawSortBy) ? rawSortBy : "sort_order";
  const safeSortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  // PAGINATION
  const safePage  = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 10));
  const offset    = (safePage - 1) * safeLimit;
  
  // COUNT Query
  const countValues = [...values];
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${M.MODULES} m ${whereClause}`,
    countValues
  );

  // Main Data Query
  values.push(safeLimit, offset);
  let orderByClause;
  if (safeSortBy === "sort_order") {
    const dir = safeSortOrder === "DESC" ? "DESC" : "ASC";
    orderByClause = `${MODULE_SORT_ORDER_EXPR} ${dir}, m.label ${dir} NULLS LAST, m.id ASC`;
  } else {
    orderByClause = `m.${safeSortBy} ${safeSortOrder}`;
  }

  const rows = await dbQuery(
    `SELECT ${safeFields} ${MODULE_LIST_JOIN}
     ${whereClause} 
     ORDER BY ${orderByClause}
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  return {
    data: rows,
    total: parseInt(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(parseInt(count) / safeLimit),
  };
};

export const findModule = async (filters = {}) => {
  if (!filters || Object.keys(filters).length === 0) return null;
  
  const keys = Object.keys(filters);
  for (const key of keys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const conditions = keys.map((k, idx) => `m.${k} = $${idx + 1}`).join(" AND ");
  const values = Object.values(filters);

  const [module] = await dbQuery(
    `SELECT m.id, m.name, m.label, m.app_type, m.sort_order, m.is_active, m.created_at, m.updated_at, m.updated_by, u_up.name AS updated_by_name
     FROM ${M.MODULES} m
     LEFT JOIN ${M.USERS} u_up ON m.updated_by = u_up.id
     WHERE ${conditions}
     LIMIT 1`,
    values
  );
  return module ?? null;
};

export const insertModule = async ({ name, label, app_type = "core" }) => {
  const [module] = await dbQuery(
    `INSERT INTO ${M.MODULES} (name, label, app_type, is_active)
     VALUES ($1, $2, $3, true)
     RETURNING id, name, label, app_type, sort_order, is_active, created_at, updated_at, updated_by`,
    [name, label, app_type]
  );
  return module;
};

export const updateModules = async (fields = {}, filters = {}) => {
  const fieldKeys  = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length || !filterKeys.length) throw new Error("No fields or filters");

  for (const key of fieldKeys)  assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const setClause   = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const values      = [...Object.values(fields), ...Object.values(filters)];

  return await dbQuery(
    `UPDATE ${M.MODULES} SET ${setClause} 
     WHERE ${whereClause}
     RETURNING id, name, label, app_type, sort_order, is_active, updated_at, updated_by`,
    values
  );
};
