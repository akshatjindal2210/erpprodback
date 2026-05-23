import dbQuery from "../config/db.js";

// ─── Column whitelists (SQL injection prevention) ─────────────────
const ALLOWED_SELECT_FIELDS = ["id", "name", "approved", "created_at", "updated_at"];
const ALLOWED_FILTER_FIELDS = ["id", "name", "approved", "created_by", "updated_by", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["id", "name", "approved", "created_at", "updated_at"];

// ─── Helper: validate column name against whitelist ───────────────
const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

// ─── FIND MULTIPLE ─────────────────────────
export const findCategories = async (options = {}) => {
  const {
    filters = {},
    fields = [],
    search = null,
    sort = {},
    page = 1,
    limit = 10,
  } = options;

  const values = [];
  let i = 1;

  const safeFields = fields.length > 0
    ? fields.filter((f) => ALLOWED_SELECT_FIELDS.includes(f)).map((f) => `c.${f}`).join(", ")
    : "c.id, c.name, c.approved, c.created_at, c.updated_at";

  const conditions = ["c.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`c.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`c.created_at <= $${i++}`);
      continue;
    }

    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
    values.push(val);
    conditions.push(`c.${key}::TEXT = $${i++}::TEXT`);
  }

  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`c.name ILIKE $${idx}`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const rawSortBy = sort.by || "created_at";
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(rawSortBy) ? rawSortBy : "created_at";
  const safeSortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (safePage - 1) * safeLimit;

  const countValues = [...values];
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM category c ${whereClause}`,
    countValues
  );

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT ${safeFields}
     FROM category c
     ${whereClause}
     ORDER BY c.${safeSortBy} ${safeSortOrder}
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  return {
    data: rows,
    total: Number(count || 0),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count || 0) / safeLimit),
  };
};

// ─── FIND ONE ─────────────────────────────
export const findCategory = async (filters = {}) => {
  if (!filters || Object.keys(filters).length === 0) return null;

  const keys = Object.keys(filters);
  for (const key of keys) {
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
  }

  const conditions = keys.map((k, idx) => `c.${k} = $${idx + 1}`).join(" AND ");
  const values = Object.values(filters);

  const [row] = await dbQuery(
    `SELECT c.id, c.name, c.approved, c.created_at, c.updated_at
     FROM category c
     WHERE ${conditions} AND c.is_deleted = false
     LIMIT 1`,
    values
  );

  return row ?? null;
};
