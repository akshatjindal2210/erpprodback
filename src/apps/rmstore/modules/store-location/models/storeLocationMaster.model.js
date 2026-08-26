import dbQuery from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { LOCATION_APP_TYPE_RMSTORE } from "../../../../ims/modules/location/models/locationMaster.model.js";

const TABLE = T.LOCATION_MASTER;
const APP_TYPE = LOCATION_APP_TYPE_RMSTORE;

const ALLOWED_FILTER_FIELDS = ["location_id", "rack_no", "row_no", "location_no", "type", "approved", "from_date", "to_date"];

const ALLOWED_SORT_FIELDS = ["location_id", "rack_no", "row_no", "type", "total_capacity", "occupied_capacity", "available_capacity", "created_at", "location_no", "item_code"];

const ALLOWED_UPDATE_FIELDS = [
  "rack_no", "row_no", "location_no", "location_description", "total_capacity",
  "type", "acc_codes", "item_dcodes",
  "approved", "approved_by", "approved_at",
  "updated_by", "updated_at",
];

const JOINS = "";

const LOC_NO_EXPR = `COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, ''))))`;
const OCCUPIED_CAPACITY_SQL = `(
  COALESCE(
    (
      SELECT COUNT(*)::int
      FROM ims_box_table b
      WHERE b.location_id = lm.location_id
        AND b.is_deleted = false
        AND (b.out_uid IS NULL OR NULLIF(TRIM(b.out_uid::text), '') IS NULL)
        AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')
    ),
    0
  ) + COALESCE(
    (
      SELECT COUNT(*)::int
      FROM rmstore_coil_table rc
      WHERE rc.location_id = lm.location_id
        AND rc.is_deleted = false
        AND COALESCE(rc.status, 'active') IN ('active', 'rejected')
    ),
    0
  )
)`;
const AVAILABLE_CAPACITY_SQL = `GREATEST(COALESCE(lm.total_capacity, 0) - (${OCCUPIED_CAPACITY_SQL}), 0)`;

const DEFAULT_FIELDS = [
  "lm.location_id", "lm.rack_no", "lm.shelf_no AS row_no",
  `${LOC_NO_EXPR} AS location_no`,
  "lm.type", "lm.location_description", "lm.total_capacity",
  `${OCCUPIED_CAPACITY_SQL} AS occupied_capacity`,
  `${AVAILABLE_CAPACITY_SQL} AS available_capacity`,
  "COALESCE(lm.acc_codes, '{}') AS acc_codes",
  "COALESCE(lm.item_dcodes, '{}') AS item_dcodes",
  "(COALESCE(lm.acc_codes, '{}'))[1] AS acc_code",
  "(COALESCE(lm.item_dcodes, '{}'))[1] AS item_dcode",
  "NULL::text AS acc_name", "NULL::text AS item_code", "NULL::text AS item_desc",
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
  const conditions = [
    "lm.is_deleted = false",
    `lower(trim(COALESCE(lm.type, ''))) = '${APP_TYPE}'`,
  ];

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;
    if (key === "type") continue;

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
    if (key === "row_no") {
      conditions.push(`UPPER(COALESCE(lm.shelf_no, '')) = UPPER($${i++})`);
    } else if (key === "location_no") {
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
      lm.shelf_no ILIKE $${idx} OR
      ${LOC_NO_EXPR} ILIKE $${idx} OR
      lm.type ILIKE $${idx} OR
      lm.location_description ILIKE $${idx} OR
      COALESCE(lm.item_dcodes::text, '') ILIKE $${idx}
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
    case "row_no": orderByClause = "lm.shelf_no"; break;
    case "location_no": orderByClause = "NULLIF(regexp_replace(lm.rack_no, '\\D', '', 'g'), '')::bigint, lm.shelf_no"; break;
    case "item_code": orderByClause = "(COALESCE(lm.item_dcodes, '{}'))[1]"; break;
    case "occupied_capacity": orderByClause = OCCUPIED_CAPACITY_SQL; break;
    case "available_capacity": orderByClause = AVAILABLE_CAPACITY_SQL; break;
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
  const conditions = [
    "lm.is_deleted = false",
    `lower(trim(COALESCE(lm.type, ''))) = '${APP_TYPE}'`,
  ];

  for (const key of keys) {
    if (key === "type") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    if (key === "row_no") {
      conditions.push(`UPPER(COALESCE(lm.shelf_no, '')) = UPPER($${i++})`);
    } else {
      conditions.push(`lm.${key} = $${i++}`);
    }
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

  const values = [rack, row, APP_TYPE];
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
       AND UPPER(trim(COALESCE(shelf_no, ''))) = $2
       AND lower(trim(COALESCE(type, ''))) = $3
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
    acc_codes = [],
    item_dcodes = [],
    acc_code = null,
    item_dcode = null,
    created_by,
  } = data;

  const nextAccCodes = Array.isArray(acc_codes) && acc_codes.length
    ? acc_codes.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : acc_code != null
      ? [Number(acc_code)]
      : [];
  const nextItemDcodes = Array.isArray(item_dcodes) && item_dcodes.length
    ? item_dcodes.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : item_dcode != null
      ? [Number(item_dcode)]
      : [];

  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (rack_no, shelf_no, location_no, type, location_description, total_capacity, acc_codes, item_dcodes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::int[], $8::int[], $9)
     RETURNING *`,
    [rack_no, row_no, location_no, APP_TYPE, location_description, total_capacity, nextAccCodes, nextItemDcodes, created_by]
  );

  return row;
};

export const updateLocations = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (!ALLOWED_UPDATE_FIELDS.includes(k)) continue;
    if (k === "row_no") {
      safeFields.shelf_no = fields[k];
    } else {
      safeFields[k] = fields[k];
    }
  }
  // Map legacy single ids → arrays when controller still sends them
  if (Object.prototype.hasOwnProperty.call(fields, "acc_code") && !Object.prototype.hasOwnProperty.call(fields, "acc_codes")) {
    safeFields.acc_codes = fields.acc_code != null ? [Number(fields.acc_code)] : [];
  }
  if (Object.prototype.hasOwnProperty.call(fields, "item_dcode") && !Object.prototype.hasOwnProperty.call(fields, "item_dcodes")) {
    safeFields.item_dcodes = fields.item_dcode != null ? [Number(fields.item_dcode)] : [];
  }
  if (Object.prototype.hasOwnProperty.call(safeFields, "acc_codes")) {
    safeFields.acc_codes = (Array.isArray(safeFields.acc_codes) ? safeFields.acc_codes : [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  if (Object.prototype.hasOwnProperty.call(safeFields, "item_dcodes")) {
    safeFields.item_dcodes = (Array.isArray(safeFields.item_dcodes) ? safeFields.item_dcodes : [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  safeFields.type = APP_TYPE;

  for (const k in filters) {
    if (!ALLOWED_FILTER_FIELDS.includes(k)) continue;
    if (k === "row_no") {
      safeFilters.shelf_no = filters[k];
    } else {
      safeFilters[k] = filters[k];
    }
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
       AND lower(trim(COALESCE(type, ''))) = '${APP_TYPE}'
     RETURNING *`,
    values
  );

  return row ?? null;
};

export const deleteLocations = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  const values = [];
  let i = 1;
  const conditions = [`lower(trim(COALESCE(type, ''))) = '${APP_TYPE}'`];

  for (const k of keys) {
    if (!ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }

  if (conditions.length <= 1) throw new Error("Invalid filters");

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
