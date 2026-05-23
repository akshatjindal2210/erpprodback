import dbQuery from "../config/db.js";
import bcrypt from "bcryptjs";

// ─── Column whitelists (SQL injection prevention) ─────────────────
const ALLOWED_SELECT_FIELDS  = ["id", "name", "username", "usercode", "email", "phone", "type", "status", "auth_source", "created_at", "updated_at"];
const ALLOWED_FILTER_FIELDS  = ["id", "usercode", "name", "username", "email", "phone", "type", "status", "auth_source", "from_date", "to_date"];
const ALLOWED_UPDATE_FIELDS  = ["id", "name", "username", "usercode", "email", "phone", "type", "status", "auth_source", "password", "updated_by", "updated_at"];
const ALLOWED_DELETE_FILTERS = ["id"];
const ALLOWED_SORT_FIELDS    = ["id", "name", "username", "email", "created_at", "updated_at", "status", "type"];

// ─── Helper: validate column name against whitelist ───────────────
const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

// ─── Find multiple users with filters, search, pagination ─────────
export const findUsers = async (options = {}) => {
  const {
    filters = {},
    fields  = [],
    sort    = {},
    page    = 1,
    limit   = 10,
    join    = "",
    search  = null,
  } = options;

  const values = [];
  let i = 1;

  // SELECT clause — validate each requested field
  const mappedSelect = fields.length > 0
    ? fields.filter(f => ALLOWED_SELECT_FIELDS.includes(f)).map(f => `u.${f}`)
    : [];
  const safeFields = mappedSelect.length > 0
    ? mappedSelect.join(", ")
    : "u.id, u.name, u.username, u.usercode, u.email, u.phone, u.type, u.status, u.auth_source, u.created_at";

  // WHERE clause
  const conditions = ["u.is_deleted = false"];

  const viewDays = Math.min(3650, Math.max(0, parseInt(options.permission?.can_view_days, 10) || 0));
  if (viewDays > 0) {
    values.push(Math.max(0, viewDays - 1));
    conditions.push(`u.created_at >= CURRENT_DATE - ($${i++} * INTERVAL '1 day')`);
  }

  for (const [key, val] of Object.entries(filters)) {
    if (key === "from_date") {
      values.push(val);
      conditions.push(`u.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`u.created_at <= $${i++}`);
      continue;
    }
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

    // Username availability: exact match, case-insensitive (not substring / ILIKE search).
    if (key === "username" && typeof val === "string" && !val.includes("%")) {
      values.push(val.trim());
      conditions.push(`LOWER(TRIM(u.username)) = LOWER(TRIM($${i++}))`);
      continue;
    }

    if (val === null) {
      conditions.push(`u.${key} IS NULL`);
    } else if (Array.isArray(val)) {
      const placeholders = val.map(() => `$${i++}`).join(", ");
      values.push(...val);
      conditions.push(`u.${key} IN (${placeholders})`);
    } else if (typeof val === "string" && val.includes("%")) {
      values.push(val);
      conditions.push(`u.${key} ILIKE $${i++}`);
    } else {
      values.push(val);
      conditions.push(`u.${key} = $${i++}`);
    }
  }

  // Search across multiple fields (already parameterized — safe)
  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(
      u.name     ILIKE $${idx} OR
      u.username ILIKE $${idx} OR
      u.email    ILIKE $${idx} OR
      u.phone    ILIKE $${idx}
    )`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  // ORDER BY — validate sort field
  const rawSortBy = sort.by || "created_at";
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(rawSortBy) ? rawSortBy : "created_at";
  const safeSortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";
  const orderClause = `ORDER BY u.${safeSortBy} ${safeSortOrder}`;

  // PAGINATION
  const safePage  = Math.max(1, parseInt(page)  || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 10));
  const offset    = (safePage - 1) * safeLimit;
  values.push(safeLimit, offset);
  const paginationClause = `LIMIT $${i++} OFFSET $${i++}`;

  // COUNT total (exclude pagination values)
  const countValues = values.slice(0, values.length - 2);
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM users u ${join} ${whereClause}`,
    countValues
  );

  const rows = await dbQuery(
    `SELECT ${safeFields} FROM users u ${join} ${whereClause} ${orderClause} ${paginationClause}`,
    values
  );

  return {
    data:       rows,
    total:      parseInt(count),
    page:       safePage,
    limit:      safeLimit,
    totalPages: Math.ceil(parseInt(count) / safeLimit),
  };
};

// ─── Find single user ─────────────────────────────────────────────
export const findUser = async (filters = {}) => {
  if (!filters || Object.keys(filters).length === 0) return null;

  const keys = Object.keys(filters);

  // Validate all filter keys
  for (const key of keys) {
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
  }

  const conditions = keys.map((k, idx) => `${k} = $${idx + 1}`).join(" AND ");
  const values = Object.values(filters);

  const [user] = await dbQuery(
    `SELECT id, name, username, usercode, email, phone, type, status, auth_source, password, created_at
     FROM users
     WHERE ${conditions} AND is_deleted = false
     LIMIT 1`,
    values
  );

  return user ?? null;
};

// ─── Find single user by username (case-insensitive) ─────────────
export const findUserByUsernameInsensitive = async (username) => {
  if (!username) return null;
  const [user] = await dbQuery(
    `SELECT id, name, username, usercode, email, phone, type, status, auth_source, password, created_at
     FROM users
     WHERE LOWER(username) = LOWER($1)
       AND is_deleted = false
     LIMIT 1`,
    [username]
  );
  return user ?? null;
};

// ─── Insert new user with hashed password ─────────────────────────
export const insertUser = async ({ name, username, email, phone, password, type, status, created_by, usercode, auth_source }) => {
  const phoneVal = phone != null ? String(phone).trim() : "";
  if (!phoneVal) throw new Error("Phone is required");

  const emailVal = email !== undefined && email !== null && String(email).trim() ? String(email).trim() : null;

  const hashed = await bcrypt.hash(password, 10);
  const [user] = await dbQuery(
    `INSERT INTO users (name, username, email, phone, password, type, status, created_by, usercode, auth_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, name, username, usercode, email, phone, type, status, auth_source`,
    [
      name,
      username,
      emailVal,
      phoneVal,
      hashed,
      type || "user",
      status ?? "active",
      created_by || null,
      usercode ?? null,
      auth_source || "erp",
    ]
  );
  return user;
};

// ─── Update users dynamically ─────────────────────────────────────
export const updateUsers = async (fields = {}, filters = {}) => {
  const fieldKeys  = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length)  throw new Error("No fields to update");
  if (!filterKeys.length) throw new Error("No filters provided");

  // Validate all field keys and filter keys
  for (const key of fieldKeys)  assertField(key, ALLOWED_UPDATE_FIELDS,  "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS,  "filter field");

  const setClause   = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const values      = [...Object.values(fields), ...Object.values(filters)];

  return await dbQuery(
    `UPDATE users SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING id, name, username, usercode, email, phone, type, status, auth_source`,
    values
  );
};

// ─── Soft delete users ────────────────────────────────────────────
export const deleteUsers = async (filters = {}, meta = {}) => {
  if (!filters || Object.keys(filters).length === 0) throw new Error("No filters provided");

  const keys = Object.keys(filters);

  // Only allow deleting by id (safest)
  for (const key of keys) assertField(key, ALLOWED_DELETE_FILTERS, "delete filter");

  const conditions = keys.map((k, idx) => `${k} = $${idx + 1}`).join(" AND ");

  await dbQuery(
    `UPDATE users
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $${keys.length + 1}
     WHERE ${conditions} AND is_deleted = false`,
    [...Object.values(filters), meta.deleted_by || null]
  );
};