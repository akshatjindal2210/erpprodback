import dbQuery from "../config/db.js";

// ─── ALLOWED CONFIG ─────────────────────────

const ALLOWED_FILTER_FIELDS = ["standard_id", "item_dcode", "type", "sticker_type", "acc_code", "approved", "from_date", "to_date"];

const ALLOWED_SORT_FIELDS = ["created_at", "approved_at", "updated_at", "qty", "item_code", "standard_id", "category_name", "sticker_type_name"];

const ALLOWED_UPDATE_FIELDS = ["item_dcode", "qty", "unit", "type", "sticker_type", "acc_code", "approved", "approved_by", "approved_at", "updated_by", "updated_at"];

// ─── JOINS ─────────────────────────
const JOINS = `
  LEFT JOIN category cat  ON ps.type       = cat.id
  LEFT JOIN sticker_type st ON ps.sticker_type = st.id

  LEFT JOIN users u_cr    ON ps.created_by  = u_cr.id
  LEFT JOIN users u_upd   ON ps.updated_by  = u_upd.id
  LEFT JOIN users u_dl    ON ps.deleted_by  = u_dl.id
  LEFT JOIN users u_ap    ON ps.approved_by = u_ap.id
`;

// ─── DEFAULT SELECT FIELDS ─────────────────────────
const DEFAULT_FIELDS = [
  "ps.standard_id", "ps.item_dcode", "ps.qty", "ps.unit", "ps.type", "ps.sticker_type", "ps.acc_code",
  "ps.approved", "ps.approved_by", "ps.approved_at",
  "ps.created_by", "ps.created_at",
  "ps.updated_by", "ps.updated_at",
  "ps.deleted_by", "ps.deleted_at",
  "ps.item_dcode::text AS item_code", "ps.acc_code::text AS acc_name", "cat.name AS category_name", "st.name AS sticker_type_name",
  "u_cr.name  AS created_by_name",
  "u_upd.name AS updated_by_name",
  "u_dl.name  AS deleted_by_name",
  "u_ap.name  AS approved_by_name"
];

// ─── FIND MULTIPLE ─────────────────────────
export const findPackingStandards = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [], permission = {} } = options;

  const values = [];
  let i = 1;

  const conditions = ["ps.is_deleted = false"];

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    // DATE FILTERS
    if (key === "from_date") {
      values.push(val);
      conditions.push(`ps.created_at >= $${i++}`);
      continue;
    }

    if (key === "to_date") {
      values.push(val);
      conditions.push(`ps.created_at <= $${i++}`);
      continue;
    }

    // NORMAL FILTERS (SAFE)
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    values.push(val);
    conditions.push(`ps.${key} = $${i++}`);
  }

  // SEARCH
  if (search) {
    const searchIndex = i;
    const searchTerm = `%${search}%`;
    values.push(searchTerm);

    conditions.push(`(
      ps.qty::TEXT ILIKE $${searchIndex} OR
      ps.unit ILIKE $${searchIndex} OR
      ps.item_dcode::text ILIKE $${searchIndex} OR
      cat.name ILIKE $${searchIndex} OR
      u_cr.name ILIKE $${searchIndex} OR
      ps.acc_code::text ILIKE $${searchIndex}
      OR st.name ILIKE $${searchIndex}
    )`);

    i++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // COUNT (WITH JOINS FIXED)
  const [{ count }] = await dbQuery(`SELECT COUNT(*) AS count FROM packing_standard ps ${JOINS} ${where}`, values);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  // SAFE SORTING
  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";
  
  let orderByClause;
  if (sortByField === "item_code") {
    orderByClause = `ps.item_dcode::text`;
  } else if (sortByField === "category_name") {
    orderByClause = `cat.name`;
  } else if (sortByField === "sticker_type_name") {
    orderByClause = `st.name`;
  } else {
    orderByClause = `ps.${sortByField}`;
  }

  switch (sortByField) {
    case "item_code":
      orderByClause = "ps.item_dcode::text";
      break;

    case "category_name":
      orderByClause = "cat.name";
      break;
    case "sticker_type_name":
      orderByClause = "st.name";
      break;

    case "qty":
      orderByClause = "ps.qty";
      break;

    case "approved_at":
      orderByClause = "ps.approved_at";
      break;

    case "updated_at":
      orderByClause = "ps.updated_at";
      break;

    case "standard_id":
      orderByClause = "ps.standard_id";
      break;

    default:
      orderByClause = "ps.created_at";
  }

  values.push(safeLimit, offset);

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM packing_standard ps
     ${JOINS}
     ${where}
     ORDER BY ${orderByClause} ${sortOrder} 
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(count / safeLimit)
  };
};

// ─── FIND ONE ─────────────────────────────
export const findPackingStandard = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;

  const conditions = ["ps.is_deleted = false"];

  for (const key of keys) {
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    values.push(filters[key]);
    conditions.push(`ps.${key} = $${i++}`);
  }

  if (conditions.length === 1) return null;

  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM packing_standard ps
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

// ─── DUPLICATE CHECKS ─────────────────────────────
export const findPackingStandardByItemAndCustomer = async ({item_dcode, acc_code, type }) => {
  const [row] = await dbQuery(
    `SELECT standard_id
     FROM packing_standard
     WHERE item_dcode  = $1
       AND acc_code = $2
       AND type        = $3
       AND is_deleted  = false
     LIMIT 1`,
    [item_dcode, acc_code, type]
  );

  return row ?? null;
};

export const findPackingStandardDuplicate = async ({item_dcode, type, acc_code = null}) => {
  const [row] = await dbQuery(
    `SELECT standard_id
     FROM packing_standard
     WHERE item_dcode = $1
       AND type = $2
       AND (acc_code IS NOT DISTINCT FROM $3)
       AND is_deleted = false
     LIMIT 1`,
    [item_dcode, type, acc_code]
  );

  return row ?? null;
};

// ─── INSERT ───────────────────────────────
export const insertPackingStandard = async (data) => {
  const { item_dcode, qty, unit, type, sticker_type, acc_code = null, created_by } = data;

  const [stickerTypeRow] = await dbQuery(
    `SELECT id
     FROM sticker_type
     WHERE name = 'box'
       AND approved = true
       AND is_deleted = false
     LIMIT 1`
  );

  const resolvedStickerType = sticker_type ?? stickerTypeRow?.id ?? null;

  const [row] = await dbQuery(
    `INSERT INTO packing_standard
     (item_dcode, qty, unit, type, sticker_type, acc_code, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [item_dcode, qty, unit, type, resolvedStickerType, acc_code, created_by]
  );

  return row;
};

// ─── UPDATE ───────────────────────────────
export const updatePackingStandards = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (ALLOWED_UPDATE_FIELDS.includes(k)) {
      safeFields[k] = fields[k];
    }
  }

  for (const k in filters) {
    if (ALLOWED_FILTER_FIELDS.includes(k)) {
      safeFilters[k] = filters[k];
    }
  }

  safeFields.updated_at = new Date();

  const fieldKeys  = Object.keys(safeFields);
  const filterKeys = Object.keys(safeFilters);

  if (!fieldKeys.length)  throw new Error("No valid fields to update");
  if (!filterKeys.length) throw new Error("No valid filters provided");

  const values = [...Object.values(safeFields), ...Object.values(safeFilters),];

  const setClause = fieldKeys
    .map((k, i) => `${k} = $${i + 1}`)
    .join(", ");

  const whereClause = filterKeys
    .map((k, i) => `${k} = $${fieldKeys.length + i + 1}`)
    .join(" AND ");

  const [row] = await dbQuery(
    `UPDATE packing_standard
     SET ${setClause}
     WHERE ${whereClause}
     RETURNING *`,
    values
  );

  return row;
};

// ─── DELETE (SOFT) ────────────────────────
export const deletePackingStandards = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) throw new Error("No filters provided");

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
    `UPDATE packing_standard
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`,
    values
  );
};

// ─── FIND DELETED ─────────────────────────
export const findDeletedStandard = async (standard_id) => {
  const [row] = await dbQuery(
    `SELECT
        ps.standard_id,
        ps.deleted_at,
        u.name AS deleted_by_name
     FROM packing_standard ps
     LEFT JOIN users u ON ps.deleted_by = u.id
     WHERE ps.standard_id = $1`,
    [standard_id]
  );

  return row ?? null;
};