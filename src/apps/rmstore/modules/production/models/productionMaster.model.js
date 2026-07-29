import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.MASTER_PRODUCTION;

const ALLOWED_FILTER_FIELDS = ["production_id", "item_dcode", "rm_item_dcode", "approved", "from_date", "to_date"];

const ALLOWED_SORT_FIELDS = ["production_id", "item_dcode", "item_code", "item_desc", "rm_item_dcode", "rm_item_code", "rm_item_desc", "approved", "created_at", "updated_at", "approved_at"];

const ALLOWED_UPDATE_FIELDS = ["item_dcode", "item_code", "item_desc", "rm_item_dcode", "rm_item_code", "rm_item_desc", "approved", "approved_by", "approved_at", "updated_by", "updated_at"];

/** Audit cols store user name snapshot (not live user id). */
const DEFAULT_FIELDS = [ "pm.production_id", "pm.item_dcode", "pm.item_code", "pm.item_desc", "pm.rm_item_dcode", "pm.rm_item_code", "pm.rm_item_desc",
  "pm.approved", "pm.approved_by", "pm.approved_at",
  "pm.created_by", "pm.created_at",
  "pm.updated_by", "pm.updated_at",
  "pm.deleted_by", "pm.deleted_at",
  "pm.created_by AS created_by_name",
  "pm.updated_by AS updated_by_name",
  "pm.approved_by AS approved_by_name",
  "pm.deleted_by AS deleted_by_name",
];

export const findProductions = async (options = {}) => {
  const {
    filters = {},
    search,
    sort = {},
    page = 1,
    limit = 10,
    fields = [],
  } = options;

  const values = [];
  let i = 1;
  const conditions = ["pm.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`pm.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`pm.created_at <= $${i++}`);
      continue;
    }

    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(val);
    conditions.push(`pm.${key} = $${i++}`);
  }

  if (search) {
    const searchTerm = `%${search}%`;
    values.push(searchTerm);
    const idx = i++;
    conditions.push(`(
      pm.item_dcode::text ILIKE $${idx} OR
      pm.rm_item_dcode::text ILIKE $${idx} OR
      COALESCE(pm.item_code, '') ILIKE $${idx} OR
      COALESCE(pm.item_desc, '') ILIKE $${idx} OR
      COALESCE(pm.rm_item_code, '') ILIKE $${idx} OR
      COALESCE(pm.rm_item_desc, '') ILIKE $${idx} OR
      pm.created_by ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} pm ${where}`,
    values
  );
  const count = countRes[0]?.count || 0;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "production_id";
  const sortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";

  let orderByClause;
  switch (sortByField) {
    case "item_code":
      orderByClause = "pm.item_code";
      break;
    case "rm_item_code":
      orderByClause = "pm.rm_item_code";
      break;
    case "rm_item_desc":
      orderByClause = "pm.rm_item_desc";
      break;
    default:
      orderByClause = `pm.${sortByField}`;
  }

  const dataValues = [...values, safeLimit, offset];

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} pm
     ${where}
     ORDER BY ${orderByClause} ${sortOrder}
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    dataValues
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(count / safeLimit),
  };
};

export const findProduction = async (filters = {}, options = {}) => {
  const { fields = [] } = options;
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;
  const conditions = ["pm.is_deleted = false"];

  for (const key of keys) {
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    conditions.push(`pm.${key} = $${i++}`);
  }

  if (conditions.length === 1) return null;

  const [row] = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} pm
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

export const findProductionDuplicate = async ({
  item_dcode,
  rm_item_dcode,
  excludeProductionId = null,
}) => {
  const item = Number(item_dcode);
  const rmItem = Number(rm_item_dcode);
  if (!Number.isFinite(item) || !Number.isFinite(rmItem)) return null;

  const values = [item, rmItem];
  let excludeClause = "";
  if (excludeProductionId != null && Number.isFinite(Number(excludeProductionId))) {
    values.push(Number(excludeProductionId));
    excludeClause = ` AND production_id <> $${values.length}`;
  }

  const [row] = await dbQuery(
    `SELECT production_id
     FROM ${TABLE}
     WHERE is_deleted = false
       AND item_dcode = $1
       AND rm_item_dcode = $2
       ${excludeClause}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

export const insertProduction = async (data) => {
  const {
    item_dcode,
    item_code,
    item_desc,
    rm_item_dcode,
    rm_item_code,
    rm_item_desc,
    created_by,
  } = data;

  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (item_dcode, item_code, item_desc, rm_item_dcode, rm_item_code, rm_item_desc, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      item_dcode,
      item_code ?? null,
      item_desc ?? null,
      rm_item_dcode,
      rm_item_code ?? null,
      rm_item_desc ?? null,
      created_by,
    ]
  );

  return row;
};

export const updateProductions = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (ALLOWED_UPDATE_FIELDS.includes(k)) safeFields[k] = fields[k];
  }
  for (const k in filters) {
    if (ALLOWED_FILTER_FIELDS.includes(k)) safeFilters[k] = filters[k];
  }

  const fieldKeys = Object.keys(safeFields);
  const filterKeys = Object.keys(safeFilters);

  if (!fieldKeys.length) throw new Error("No valid fields to update");
  if (!filterKeys.length) throw new Error("No valid filters provided");

  const values = [...Object.values(safeFields), ...Object.values(safeFilters)];
  const setClause = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const whereClause = filterKeys
    .map((k, i) => `${k} = $${fieldKeys.length + i + 1}`)
    .join(" AND ");

  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING *`,
    values
  );

  return row ?? null;
};

export const deleteProductions = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  const values = [];
  let i = 1;
  const conditions = [];

  for (const k of keys) {
    if (!ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }

  if (!conditions.length) throw new Error("Invalid filters");

  values.push(meta.deleted_by ?? null);

  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`,
    values
  );
};
