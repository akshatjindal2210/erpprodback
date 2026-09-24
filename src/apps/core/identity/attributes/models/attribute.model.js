import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { MST_TABLES } from "../../../../../config/db/dbTables.js";

const TABLE = MST_TABLES.ATTRIBUTES;
const USERS_TABLE = MST_TABLES.USERS;

export const ATTRIBUTE_NAME_MAX_LENGTH = 100;

const ALLOWED_SELECT_FIELDS = ["id", "name", "created_at", "updated_at"];
const ALLOWED_FILTER_FIELDS = ["id", "name", "from_date", "to_date"];
const ALLOWED_UPDATE_FIELDS = ["name"];
const ALLOWED_SORT_FIELDS   = ["id", "name", "created_at"];

const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

export const normalizeAttributeName = (raw) => String(raw ?? "").replace(/\s+/g, " ").trim();

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
    data: rows,
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
    `SELECT a.id, a.name, a.created_at, a.updated_at FROM ${TABLE} a
     WHERE ${conditions} AND a.is_deleted = false LIMIT 1`,
    Object.values(filters)
  );
  return row ?? null;
};

/** Returns null when an active attribute with the same name (case-insensitive) already exists. */
export const insertAttribute = async ({ name }) => {
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (name) VALUES ($1)
     ON CONFLICT ((LOWER(name))) DO UPDATE SET is_deleted = false, name = EXCLUDED.name
       WHERE ${TABLE}.is_deleted = true
     RETURNING id, name, created_at, updated_at`,
    [name]
  );
  return row ?? null;
};

export const updateAttribute = async (fields = {}, filters = {}) => {
  const fieldKeys  = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length || !filterKeys.length) throw new Error("No fields or filters");

  for (const key of fieldKeys)  assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const setClause   = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");

  return await dbQuery(
    `UPDATE ${TABLE} SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING id, name, created_at, updated_at`,
    [...Object.values(fields), ...Object.values(filters)]
  );
};

export const softDeleteAttribute = async ({ id }) => {
  if (id == null) throw new Error("No filters");
  return await dbQuery(
    `UPDATE ${TABLE} SET is_deleted = true
     WHERE id = $1 AND is_deleted = false
     RETURNING id, name`,
    [id]
  );
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
  const sql = `SELECT a.id, a.name
               FROM ${USERS_TABLE} u
               JOIN ${TABLE} a ON a.id = ANY(u.attribute_ids) AND a.is_deleted = false
               WHERE u.id = $1
               ORDER BY a.name ASC`;
  if (client) return (await client.query(sql, [userId])).rows;
  return await dbQuery(sql, [userId]);
};

/** Replace the user's attribute set with `{ ids, names }` (from `parseAttributeInput`); new names are created. */
export const syncUserAttributes = async (userId, { ids = [], names = [] } = {}) =>
  withTransaction(async (client) => {
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

    await client.query(
      `UPDATE ${USERS_TABLE} SET attribute_ids = $2::int[] WHERE id = $1`,
      [userId, [...resolved].sort((a, b) => a - b)]
    );

    return findUserAttributes(userId, client);
  });
