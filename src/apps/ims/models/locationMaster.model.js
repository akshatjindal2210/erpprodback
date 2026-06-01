import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

const ALLOWED_FILTER_FIELDS = ["location_id", "rack_no", "shelf_no", "location_no", "acc_code", "item_dcode", "approved", "from_date", "to_date"];

const ALLOWED_SORT_FIELDS = ["location_id", "rack_no", "shelf_no", "total_capacity", "created_at", "acc_name", "item_code", "location_no"];

const ALLOWED_UPDATE_FIELDS = [
  "rack_no", "shelf_no", "location_no", "location_description", "total_capacity",
  "acc_code", "item_dcode", "approved", "approved_by", "approved_at", 
  "updated_by", "updated_at"
];

const JOINS = `
  LEFT JOIN ${M.USERS} u_cr ON lm.created_by = u_cr.id
  LEFT JOIN ${M.USERS} u_up ON lm.updated_by = u_up.id
  LEFT JOIN ${M.USERS} u_ap ON lm.approved_by = u_ap.id
  LEFT JOIN ${M.USERS} u_dl ON lm.deleted_by = u_dl.id
`;

const DEFAULT_FIELDS = [
  "lm.location_id", "lm.rack_no", "lm.shelf_no", "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no", "lm.location_description", "lm.total_capacity",
  "lm.acc_code", "lm.item_dcode", "lm.approved", "lm.created_at", "lm.updated_at",
  "lm.acc_code::text AS acc_name", "lm.item_dcode::text AS item_code", "NULL::text AS item_desc",
  "u_cr.name AS created_by_name",
  "u_up.name AS updated_by_name",
  "u_ap.name AS approved_by_name",
  "u_dl.name AS deleted_by_name"
];

export const findLocations = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [], permission = {} } = options;

  const values = [];
  let i = 1;

  const conditions = ["lm.is_deleted = false"];

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    // DATE FILTERS
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

    // NORMAL FILTERS (SAFE CHECK)
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    values.push(val);
    if (key === "location_no") {
      conditions.push(`COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) = $${i++}`);
    } else {
      conditions.push(`lm.${key} = $${i++}`);
    }
  }

  // SEARCH
  if (search) {
    const searchTerm = `%${search}%`;
    values.push(searchTerm);
    const idx = i++;

    conditions.push(`(
      lm.rack_no ILIKE $${idx} OR
      lm.shelf_no ILIKE $${idx} OR
      CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, ''))) ILIKE $${idx} OR
      lm.location_description ILIKE $${idx} OR
      lm.acc_code::text ILIKE $${idx} OR
      lm.item_dcode::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // COUNT
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ims_location_master lm ${JOINS} ${where}`, values);
  const count = countRes[0]?.count || 0;

  // PAGINATION
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  // SAFE SORTING
  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "location_id";
  const sortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  let orderByClause;
  switch (sortByField) {
    case "acc_name": orderByClause = "lm.acc_code::text"; break;
    case "item_code": orderByClause = "lm.item_dcode::text"; break;
    case "location_no": orderByClause = "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, ''))))"; break;
    default: orderByClause = `lm.${sortByField}`;
  }

  const dataValues = [...values, safeLimit, offset];

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM ims_location_master lm
     ${JOINS}
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
    totalPages: Math.ceil(count / safeLimit)
  };
};

export const findLocation = async (filters = {}) => {
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
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ims_location_master lm
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

function normHierarchyCode(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isNaN(n)) return String(Math.trunc(n));
  }
  return s;
}

/**
 * Inward storage suggestion, strict order:
 * (1) customer + item on location, both match box
 * (2) customer-only on location (acc matches, item_dcode NULL on master)
 * (3) item-only on location (acc NULL, item matches)
 * (4) open racks (both NULL on master) — all matches up to cap
 * returns {{ rows: object[], match_tier: 1|2|3|4|null }}
 */
export const findSuggestedInwardLocationByHierarchy = async ({ acc_code, item_dcode }) => {
  const approved = "lm.is_deleted = false AND lm.approved = true";
  const orderOne = "ORDER BY lm.location_id ASC LIMIT 1";
  const MAX_OPEN_LOCATIONS = 2000;

  const accN = normHierarchyCode(acc_code);
  const itemN = normHierarchyCode(item_dcode);
  const hasItem = Boolean(itemN);
  const hasAcc = Boolean(accN);

  const select = `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ims_location_master lm
     ${JOINS}
     WHERE ${approved}`;

  if (hasItem && hasAcc) {
    const rows1 = await dbQuery(
      `${select}
       AND lm.acc_code IS NOT NULL
       AND lm.item_dcode IS NOT NULL
       AND trim(lm.acc_code::text) = $1
       AND trim(lm.item_dcode::text) = $2
       ${orderOne}`,
      [accN, itemN]
    );
    if (rows1?.length) return { rows: rows1, match_tier: 1 };
  }

  if (hasAcc) {
    const rows2 = await dbQuery(
      `${select}
       AND lm.acc_code IS NOT NULL
       AND lm.item_dcode IS NULL
       AND trim(lm.acc_code::text) = $1
       ${orderOne}`,
      [accN]
    );
    if (rows2?.length) return { rows: rows2, match_tier: 2 };
  }

  if (hasItem) {
    const rows3 = await dbQuery(
      `${select}
       AND lm.acc_code IS NULL
       AND lm.item_dcode IS NOT NULL
       AND trim(lm.item_dcode::text) = $1
       ${orderOne}`,
      [itemN]
    );
    if (rows3?.length) return { rows: rows3, match_tier: 3 };
  }

  const rows4 = await dbQuery(
    `${select}
     AND lm.acc_code IS NULL
     AND lm.item_dcode IS NULL
     ORDER BY lm.location_id ASC
     LIMIT ${MAX_OPEN_LOCATIONS}`
  );
  if (rows4?.length) return { rows: rows4, match_tier: 4 };

  return { rows: [], match_tier: null };
};

export const findLocationDuplicate = async ({ rack_no, shelf_no, excludeLocationId = null }) => {
  const rack = rack_no?.toString().trim();
  const shelf = shelf_no?.toString().trim().toUpperCase();
  if (!rack || !shelf) return null;

  const values = [rack, shelf];
  let excludeClause = "";
  if (excludeLocationId != null && Number.isFinite(Number(excludeLocationId))) {
    values.push(Number(excludeLocationId));
    excludeClause = ` AND location_id <> $${values.length}`;
  }

  const [row] = await dbQuery(
    `SELECT location_id
     FROM ims_location_master
     WHERE is_deleted = false
       AND trim(rack_no) = $1
       AND UPPER(trim(COALESCE(shelf_no, ''))) = $2
       ${excludeClause}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

export const insertLocation = async (data) => {
  const { rack_no, shelf_no, location_no, location_description, total_capacity, acc_code, item_dcode, created_by } = data;

  const [row] = await dbQuery(
    `INSERT INTO ims_location_master
     (rack_no, shelf_no, location_no, location_description, total_capacity, acc_code, item_dcode, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [rack_no, shelf_no, location_no, location_description, total_capacity, acc_code, item_dcode, created_by]
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
    `UPDATE ims_location_master
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
    `UPDATE ims_location_master
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`,
    values
  );
};