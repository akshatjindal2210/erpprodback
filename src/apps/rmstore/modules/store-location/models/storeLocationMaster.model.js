import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.MASTER_LOCATION;

const ALLOWED_FILTER_FIELDS = ["location_id", "rack_no", "row_no", "location_no", "item_dcode", "approved", "from_date", "to_date"];

const ALLOWED_SORT_FIELDS = ["location_id", "rack_no", "row_no", "total_capacity", "created_at", "location_no", "item_code"];

const ALLOWED_UPDATE_FIELDS = [
  "rack_no", "row_no", "location_no", "location_description", "total_capacity",
  "item_dcode", "item_code", "item_desc",
  "approved", "approved_by", "approved_at",
  "updated_by", "updated_at",
];

const JOINS = "";

const LOC_NO_EXPR = `COALESCE(lm.location_no, CONCAT('RM-', lm.rack_no, UPPER(COALESCE(lm.row_no, ''))))`;

/** Audit cols store user name snapshot (not live user id). */
const DEFAULT_FIELDS = [
  "lm.location_id", "lm.rack_no", "lm.row_no",
  `${LOC_NO_EXPR} AS location_no`,
  "lm.location_description", "lm.total_capacity",
  "lm.item_dcode", "lm.item_code", "lm.item_desc",
  "lm.approved", "lm.approved_by", "lm.approved_at",
  "lm.created_by", "lm.created_at", "lm.updated_by", "lm.updated_at", "lm.deleted_by", "lm.deleted_at",
  "lm.created_by AS created_by_name",
  "lm.updated_by AS updated_by_name",
  "lm.approved_by AS approved_by_name",
  "lm.deleted_by AS deleted_by_name",
];

export { DEFAULT_FIELDS as LOCATION_DEFAULT_FIELDS };

export const findLocations = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [] } = options;

  const values = [];
  let i = 1;
  const conditions = ["lm.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`lm.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`lm.created_at <= $${i++}`);
      continue;
    }

    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    values.push(val);
    if (key === "location_no") {
      conditions.push(`${LOC_NO_EXPR} = $${i++}`);
    } else {
      conditions.push(`lm.${key} = $${i++}`);
    }
  }

  if (search) {
    const searchTerm = `%${search}%`;
    values.push(searchTerm);
    const idx = i++;

    conditions.push(`(
      lm.rack_no ILIKE $${idx} OR
      lm.row_no ILIKE $${idx} OR
      ${LOC_NO_EXPR} ILIKE $${idx} OR
      lm.location_description ILIKE $${idx} OR
      COALESCE(lm.item_code, '') ILIKE $${idx} OR
      COALESCE(lm.item_desc, '') ILIKE $${idx} OR
      lm.item_dcode::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} lm ${JOINS} ${where}`, values);
  const count = countRes[0]?.count || 0;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "location_id";
  const sortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  let orderByClause;
  switch (sortByField) {
    case "location_no": orderByClause = "NULLIF(regexp_replace(lm.rack_no, '\\D', '', 'g'), '')::bigint, lm.row_no"; break;
    case "item_code": orderByClause = "lm.item_code"; break;
    default: orderByClause = `lm.${sortByField}`;
  }

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} lm
     ${JOINS}
     ${where}
     ORDER BY ${orderByClause} ${sortOrder}
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(count / safeLimit),
  };
};

export const findLocation = async (filters = {}, options = {}) => {
  const { fields = [] } = options;
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;
  const conditions = ["lm.is_deleted = false"];

  for (const key of keys) {
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    conditions.push(`lm.${key} = $${i++}`);
  }

  const [row] = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} lm
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

export const findLocationDuplicate = async ({ rack_no, row_no, excludeLocationId = null }) => {
  const rack = rack_no?.toString().trim();
  const row = row_no?.toString().trim().toUpperCase();
  if (!rack || !row) return null;

  const values = [rack, row];
  let excludeClause = "";
  if (excludeLocationId != null && Number.isFinite(Number(excludeLocationId))) {
    values.push(Number(excludeLocationId));
    excludeClause = ` AND location_id <> $${values.length}`;
  }

  const [found] = await dbQuery(
    `SELECT location_id
     FROM ${TABLE}
     WHERE is_deleted = false
       AND trim(rack_no) = $1
       AND UPPER(trim(COALESCE(row_no, ''))) = $2
       ${excludeClause}
     LIMIT 1`,
    values
  );

  return found ?? null;
};

export const insertLocation = async (data) => {
  const {
    rack_no,
    row_no,
    location_no,
    location_description,
    total_capacity,
    item_dcode = null,
    item_code = null,
    item_desc = null,
    created_by,
  } = data;

  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (rack_no, row_no, location_no, location_description, total_capacity, item_dcode, item_code, item_desc, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [rack_no, row_no, location_no, location_description, total_capacity, item_dcode, item_code, item_desc, created_by]
  );

  return row;
};

export const updateLocations = async (fields = {}, filters = {}) => {
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
  const whereClause = filterKeys.map((k, i) => `${k} = $${fieldKeys.length + i + 1}`).join(" AND ");

  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING *`,
    values
  );

  return row ?? null;
};

export const deleteLocations = async (filters = {}, meta = {}) => {
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
