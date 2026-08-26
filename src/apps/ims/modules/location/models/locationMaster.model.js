import dbQuery from "../../../../../config/db/db.js";

export const LOCATION_APP_TYPE_IMS = "ims";
export const LOCATION_APP_TYPE_RMSTORE = "rmstore";

const ALLOWED_FILTER_FIELDS = ["location_id", "rack_no", "shelf_no", "location_no", "type", "approved", "from_date", "to_date"];

const ALLOWED_SORT_FIELDS = ["location_id", "rack_no", "shelf_no", "type", "total_capacity", "occupied_capacity", "available_capacity", "created_at", "acc_name", "item_code", "location_no"];

const ALLOWED_UPDATE_FIELDS = [
  "rack_no", "shelf_no", "location_no", "location_description", "total_capacity",
  "type", "acc_codes", "item_dcodes", "rule",
  "approved", "approved_by", "approved_at",
  "updated_by", "updated_at"
];

export function normalizeLocationRule(value) {
  const mode = String(value ?? "include").trim().toLowerCase();
  return mode === "exclude" ? "exclude" : "include";
}

const JOINS = "";
const OCCUPIED_CAPACITY_SQL = `(
  COALESCE(
    (
      SELECT COUNT(*)::int
      FROM ims_box_table b
      WHERE b.location_id = lm.location_id AND b.is_deleted = false AND (b.out_uid IS NULL OR NULLIF(TRIM(b.out_uid::text), '') IS NULL) AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')
    ),
    0
  ) + COALESCE(
    (
      SELECT COUNT(*)::int
      FROM rmstore_coil_table rc
      WHERE rc.location_id = lm.location_id AND rc.is_deleted = false AND COALESCE(rc.status, 'active') IN ('active', 'rejected')
    ),
    0
  )
)`;
const AVAILABLE_CAPACITY_SQL = `GREATEST(COALESCE(lm.total_capacity, 0) - (${OCCUPIED_CAPACITY_SQL}), 0)`;

const HAS_ACC = `(lm.acc_codes IS NOT NULL AND cardinality(lm.acc_codes) > 0)`;
const HAS_ITEM = `(lm.item_dcodes IS NOT NULL AND cardinality(lm.item_dcodes) > 0)`;
const NO_ACC = `(lm.acc_codes IS NULL OR cardinality(lm.acc_codes) = 0)`;
const NO_ITEM = `(lm.item_dcodes IS NULL OR cardinality(lm.item_dcodes) = 0)`;
const IS_INCLUDE = `(COALESCE(NULLIF(lower(trim(lm.rule)), ''), 'include') = 'include')`;

/** Audit cols store user name snapshot (not live user id). */
const DEFAULT_FIELDS = [
  "lm.location_id", "lm.rack_no", "lm.shelf_no", "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no", "lm.type", "lm.location_description", "lm.total_capacity",
  `${OCCUPIED_CAPACITY_SQL} AS occupied_capacity`,
  `${AVAILABLE_CAPACITY_SQL} AS available_capacity`,
  "COALESCE(lm.acc_codes, '{}') AS acc_codes",
  "COALESCE(lm.item_dcodes, '{}') AS item_dcodes",
  "(COALESCE(lm.acc_codes, '{}'))[1] AS acc_code",
  "(COALESCE(lm.item_dcodes, '{}'))[1] AS item_dcode",
  "COALESCE(NULLIF(lower(trim(lm.rule)), ''), 'include') AS rule",
  "lm.approved", "lm.approved_by", "lm.approved_at",
  "lm.created_by", "lm.created_at", "lm.updated_by", "lm.updated_at", "lm.deleted_by", "lm.deleted_at",
  "NULL::text AS acc_name", "NULL::text AS item_code", "NULL::text AS item_desc",
  "lm.created_by AS created_by_name",
  "lm.updated_by AS updated_by_name",
  "lm.approved_by AS approved_by_name",
  "lm.deleted_by AS deleted_by_name"
];

export { DEFAULT_FIELDS as LOCATION_DEFAULT_FIELDS };

/** Normalize to unique positive ints (arrays or single value). */
export function normalizeIntIds(value) {
  const arr = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    const id = Math.trunc(n);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export const findLocations = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [] } = options;

  const values = [];
  let i = 1;
  const conditions = [
    "lm.is_deleted = false",
    `lower(trim(COALESCE(lm.type, '${LOCATION_APP_TYPE_IMS}'))) = '${LOCATION_APP_TYPE_IMS}'`,
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
    if (key === "location_no") {
      conditions.push(`COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) = $${i++}`);
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
      CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, ''))) ILIKE $${idx} OR
      lm.type ILIKE $${idx} OR
      lm.location_description ILIKE $${idx} OR
      COALESCE(lm.acc_codes::text, '') ILIKE $${idx} OR
      COALESCE(lm.item_dcodes::text, '') ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ims_location_master lm ${JOINS} ${where}`, values);
  const count = countRes[0]?.count || 0;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "location_id";
  const sortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  let orderByClause;
  switch (sortByField) {
    case "acc_name": orderByClause = "(COALESCE(lm.acc_codes, '{}'))[1]"; break;
    case "item_code": orderByClause = "(COALESCE(lm.item_dcodes, '{}'))[1]"; break;
    case "location_no": orderByClause = "NULLIF(regexp_replace(lm.rack_no, '\\D', '', 'g'), '')::bigint, lm.shelf_no"; break;
    case "occupied_capacity": orderByClause = OCCUPIED_CAPACITY_SQL; break;
    case "available_capacity": orderByClause = AVAILABLE_CAPACITY_SQL; break;
    default: orderByClause = `lm.${sortByField}`;
  }

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM ims_location_master lm
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
    totalPages: Math.ceil(count / safeLimit)
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
    `lower(trim(COALESCE(lm.type, '${LOCATION_APP_TYPE_IMS}'))) = '${LOCATION_APP_TYPE_IMS}'`,
  ];

  for (const key of keys) {
    if (key === "type") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    conditions.push(`lm.${key} = $${i++}`);
  }

  const [row] = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
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
 * Inward storage suggestion (IMS locations only).
 * Multi customer/item: match if ANY selected code is on the location.
 */
export const findSuggestedInwardLocationByHierarchy = async ({ acc_code, item_dcode }) => {
  const approved = `lm.is_deleted = false AND lm.approved = true AND lower(trim(COALESCE(lm.type, '${LOCATION_APP_TYPE_IMS}'))) = '${LOCATION_APP_TYPE_IMS}'`;
  const orderOne = "ORDER BY lm.location_id ASC LIMIT 1";
  const MAX_OPEN_LOCATIONS = 2000;

  const accN = normHierarchyCode(acc_code);
  const itemN = normHierarchyCode(item_dcode);
  const hasItem = Boolean(itemN);
  const hasAcc = Boolean(accN);
  const accInt = hasAcc && /^-?\d+$/.test(accN) ? Number(accN) : null;
  const itemInt = hasItem && /^-?\d+$/.test(itemN) ? Number(itemN) : null;

  const select = `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ims_location_master lm
     ${JOINS}
     WHERE ${approved}`;

  // Suggestion tiers only use include-mode allowlists (exclude is denylist).
  if (hasItem && hasAcc && accInt != null && itemInt != null) {
    const rows1 = await dbQuery(
      `${select}
       AND ${IS_INCLUDE} AND ${HAS_ACC} AND ${HAS_ITEM}
       AND $1::int = ANY(lm.acc_codes)
       AND $2::int = ANY(lm.item_dcodes)
       ${orderOne}`,
      [accInt, itemInt]
    );
    if (rows1?.length) return { rows: rows1, match_tier: 1 };
  }

  if (hasAcc && accInt != null) {
    const rows2 = await dbQuery(
      `${select}
       AND ${IS_INCLUDE} AND ${HAS_ACC} AND ${NO_ITEM}
       AND $1::int = ANY(lm.acc_codes)
       ${orderOne}`,
      [accInt]
    );
    if (rows2?.length) return { rows: rows2, match_tier: 2 };
  }

  if (hasItem && itemInt != null) {
    const rows3 = await dbQuery(
      `${select}
       AND ${IS_INCLUDE} AND ${NO_ACC} AND ${HAS_ITEM}
       AND $1::int = ANY(lm.item_dcodes)
       ${orderOne}`,
      [itemInt]
    );
    if (rows3?.length) return { rows: rows3, match_tier: 3 };
  }

  const rows4 = await dbQuery(
    `${select}
     AND ${NO_ACC} AND ${NO_ITEM}
     ORDER BY lm.location_id ASC
     LIMIT ${MAX_OPEN_LOCATIONS}`
  );
  if (rows4?.length) return { rows: rows4, match_tier: 4 };

  return { rows: [], match_tier: null };
};

export const findLocationDuplicate = async ({ rack_no, shelf_no, type = LOCATION_APP_TYPE_IMS, excludeLocationId = null }) => {
  const rack = rack_no?.toString().trim();
  const shelf = shelf_no?.toString().trim().toUpperCase();
  const appType = String(type || LOCATION_APP_TYPE_IMS).trim().toLowerCase() || LOCATION_APP_TYPE_IMS;
  if (!rack || !shelf) return null;

  const values = [rack, shelf, appType];
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
       AND lower(trim(COALESCE(type, '${LOCATION_APP_TYPE_IMS}'))) = $3
       ${excludeClause}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

export const insertLocation = async (data) => {
  const {
    rack_no,
    shelf_no,
    location_no,
    type = LOCATION_APP_TYPE_IMS,
    location_description,
    total_capacity,
    acc_codes = [],
    item_dcodes = [],
    restriction_mode = "include",
    rule = "include",
    created_by,
  } = data;

  const codes = normalizeIntIds(acc_codes);
  const items = normalizeIntIds(item_dcodes);
  // Include/exclude only applies when at least one item is set; customer-only = always include
  const mode = items.length
    ? normalizeLocationRule(rule ?? restriction_mode)
    : "include";

  const [row] = await dbQuery(
    `INSERT INTO ims_location_master
     (rack_no, shelf_no, location_no, type, location_description, total_capacity,
      acc_codes, item_dcodes, rule, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::int[], $8::int[], $9, $10)
     RETURNING *`,
    [
      rack_no,
      shelf_no,
      location_no,
      type || LOCATION_APP_TYPE_IMS,
      location_description,
      total_capacity,
      codes,
      items,
      mode,
      created_by,
    ]
  );

  return row;
};

export const updateLocations = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (ALLOWED_UPDATE_FIELDS.includes(k)) safeFields[k] = fields[k];
  }
  if (Object.prototype.hasOwnProperty.call(safeFields, "rule")) {
    safeFields.rule = normalizeLocationRule(safeFields.rule);
  }
  if (Object.prototype.hasOwnProperty.call(safeFields, "restriction_mode")) {
    safeFields.rule = normalizeLocationRule(safeFields.restriction_mode);
    delete safeFields.restriction_mode;
  }
  if (Object.prototype.hasOwnProperty.call(safeFields, "acc_codes")) {
    safeFields.acc_codes = normalizeIntIds(safeFields.acc_codes);
  }
  if (Object.prototype.hasOwnProperty.call(safeFields, "item_dcodes")) {
    safeFields.item_dcodes = normalizeIntIds(safeFields.item_dcodes);
  }
  // Customer-only locations always store include
  if (Object.prototype.hasOwnProperty.call(safeFields, "item_dcodes") && !safeFields.item_dcodes.length) {
    safeFields.rule = "include";
  }
  // Always write as ims — client cannot override type
  safeFields.type = LOCATION_APP_TYPE_IMS;

  for (const k in filters) {
    if (k === "type") continue;
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
       AND lower(trim(COALESCE(type, '${LOCATION_APP_TYPE_IMS}'))) = '${LOCATION_APP_TYPE_IMS}'
     RETURNING *`,
    values
  );

  return row ?? null;
};

export const deleteLocations = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  const values = [];
  let i = 1;
  const conditions = [
    `lower(trim(COALESCE(type, '${LOCATION_APP_TYPE_IMS}'))) = '${LOCATION_APP_TYPE_IMS}'`,
  ];

  for (const k of keys) {
    if (k === "type") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }

  if (conditions.length <= 1) throw new Error("Invalid filters");

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
