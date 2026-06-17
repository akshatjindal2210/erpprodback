import dbQuery from "../../../config/db.js";
import bcrypt from "bcryptjs";
import { MST_TABLES as T } from "../../../config/dbTables.js";

const TABLE = T.USERS;

// --- Column whitelists (SQL injection prevention) -----------------
const USER_LIST_JOIN = `
  LEFT JOIN ${T.DEPARTMENTS} d ON u.department_id = d.id
  LEFT JOIN ${T.DESIGNATIONS} des ON u.designation_id = des.id
`;

const ALLOWED_SELECT_FIELDS = [
  "id", "name", "username", "usercode", "email", "phone", "type", "status",
  "auth_source", "department_id", "designation_id", "created_at", "updated_at",
];
const ALLOWED_FILTER_FIELDS = [
  "id", "usercode", "name", "username", "email", "phone", "type", "status",
  "auth_source", "department_id", "designation_id", "from_date", "to_date",
];
const ALLOWED_UPDATE_FIELDS = [
  "id", "name", "username", "usercode", "email", "phone", "type", "status",
  "auth_source", "department_id", "designation_id", "password", "updated_by", "updated_at",
];
const ALLOWED_DELETE_FILTERS = ["id"];
const ALLOWED_SORT_FIELDS = [
  "id", "name", "username", "email", "created_at", "updated_at", "status", "type",
];

const FIND_USER_COLUMNS =
  "id, name, username, usercode, email, phone, type, status, auth_source, password, created_at";

const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

const attachTaskRelations = (user) => {
  if (!user) return user;
  user.department = user.department_id
    ? { id: user.department_id, name: user.department_name }
    : null;
  user.designation = user.designation_id
    ? { id: user.designation_id, name: user.designation_name }
    : null;
  return user;
};

// --- Find multiple users with filters, search, pagination ---------
export const findUsers = async (options = {}) => {
  const {
    filters = {},
    fields = [],
    sort = {},
    page = 1,
    limit = 10,
    join = "",
    search = null,
  } = options;

  const values = [];
  let i = 1;

  const mappedSelect = fields.length > 0
    ? fields.filter((f) => ALLOWED_SELECT_FIELDS.includes(f)).map((f) => `u.${f}`)
    : [];
  if (mappedSelect.length > 0) {
    const wantsDept = fields.includes("department_id");
    const wantsDesig = fields.includes("designation_id");
    if (wantsDept && !mappedSelect.some((c) => c.includes("department_name"))) {
      mappedSelect.push("d.name AS department_name");
    }
    if (wantsDesig && !mappedSelect.some((c) => c.includes("designation_name"))) {
      mappedSelect.push("des.name AS designation_name");
    }
  }
  const effectiveJoin = join || USER_LIST_JOIN;
  const safeFields = mappedSelect.length > 0
    ? mappedSelect.join(", ")
    : `u.id, u.name, u.username, u.usercode, u.email, u.phone, u.type, u.status, u.auth_source,
       u.department_id, u.designation_id, d.name AS department_name, des.name AS designation_name, u.created_at`;

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
      if (key === "usercode") {
        conditions.push(`CAST(u.usercode AS TEXT) ILIKE $${i++}`);
      } else {
        conditions.push(`u.${key} ILIKE $${i++}`);
      }
    } else {
      values.push(val);
      conditions.push(`u.${key} = $${i++}`);
    }
  }

  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(
      u.name     ILIKE $${idx} OR
      u.username ILIKE $${idx} OR
      u.email    ILIKE $${idx} OR
      u.phone    ILIKE $${idx} OR
      CAST(u.usercode AS TEXT) ILIKE $${idx}
    )`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const rawSortBy = sort.by || "created_at";
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(rawSortBy) ? rawSortBy : "created_at";
  const safeSortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";
  const orderClause = `ORDER BY u.${safeSortBy} ${safeSortOrder}`;

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(5000, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (safePage - 1) * safeLimit;
  values.push(safeLimit, offset);
  const paginationClause = `LIMIT $${i++} OFFSET $${i++}`;

  const countValues = values.slice(0, values.length - 2);
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} u ${effectiveJoin} ${whereClause}`,
    countValues
  );

  const rows = await dbQuery(
    `SELECT ${safeFields} FROM ${TABLE} u ${effectiveJoin} ${whereClause} ${orderClause} ${paginationClause}`,
    values
  );

  return {
    data: rows.map(attachTaskRelations),
    total: parseInt(count, 10),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(parseInt(count, 10) / safeLimit) || 0,
  };
};

// --- Find single user ---------------------------------------------
export const findUser = async (filters = {}) => {
  if (!filters || Object.keys(filters).length === 0) return null;

  const keys = Object.keys(filters);
  for (const key of keys) {
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
  }

  if (keys.length === 1 && keys[0] === "id") {
    const [user] = await dbQuery(
      `SELECT u.*,
              d.name AS department_name,
              des.name AS designation_name
       FROM ${TABLE} u
       LEFT JOIN ${T.DEPARTMENTS} d ON u.department_id = d.id
       LEFT JOIN ${T.DESIGNATIONS} des ON u.designation_id = des.id
       WHERE u.id = $1 AND u.is_deleted = false
       LIMIT 1`,
      [filters.id]
    );
    return attachTaskRelations(user ?? null);
  }

  const conditions = keys.map((k, idx) => `u.${k} = $${idx + 1}`).join(" AND ");
  const values = Object.values(filters);

  const [user] = await dbQuery(
    `SELECT ${FIND_USER_COLUMNS}
     FROM ${TABLE} u
     WHERE ${conditions} AND u.is_deleted = false
     LIMIT 1`,
    values
  );

  return user ?? null;
};

// --- Find single user by username (case-insensitive) -------------
export const findUserByUsernameInsensitive = async (username) => {
  if (!username) return null;
  const [user] = await dbQuery(
    `SELECT ${FIND_USER_COLUMNS}
     FROM ${TABLE}
     WHERE LOWER(username) = LOWER($1)
       AND is_deleted = false
     LIMIT 1`,
    [username]
  );
  return user ?? null;
};

// --- Insert new user with hashed password -------------------------
export const insertUser = async ({
  name,
  username,
  email,
  phone,
  password,
  type,
  status,
  created_by,
  usercode,
  auth_source,
  department_id,
  designation_id,
}) => {
  const phoneVal = phone != null ? String(phone).trim() : "";
  if (!phoneVal) throw new Error("Phone is required");

  const emailVal =
    email !== undefined && email !== null && String(email).trim()
      ? String(email).trim()
      : null;

  const hashed = await bcrypt.hash(password, 10);
  const deptId =
    department_id !== undefined && department_id !== null && String(department_id).trim() !== ""
      ? Number(department_id)
      : null;
  const desigId =
    designation_id !== undefined && designation_id !== null && String(designation_id).trim() !== ""
      ? Number(designation_id)
      : null;

  const [user] = await dbQuery(
    `INSERT INTO ${TABLE} (name, username, email, phone, password, type, status, created_by, usercode, auth_source, department_id, designation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, name, username, usercode, email, phone, type, status, auth_source, department_id, designation_id`,
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
      Number.isFinite(deptId) ? deptId : null,
      Number.isFinite(desigId) ? desigId : null,
    ]
  );
  return user;
};

// --- Update users dynamically -------------------------------------
export const updateUsers = async (fields = {}, filters = {}) => {
  const fieldKeys = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length) throw new Error("No fields to update");
  if (!filterKeys.length) throw new Error("No filters provided");

  for (const key of fieldKeys) assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const setClause = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys
    .map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`)
    .join(" AND ");
  const values = [...Object.values(fields), ...Object.values(filters)];

  return await dbQuery(
    `UPDATE ${TABLE} SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING id, name, username, usercode, email, phone, type, status, auth_source, department_id, designation_id`,
    values
  );
};

// --- Soft delete users --------------------------------------------
export const deleteUsers = async (filters = {}, meta = {}) => {
  if (!filters || Object.keys(filters).length === 0) throw new Error("No filters provided");

  const keys = Object.keys(filters);
  for (const key of keys) assertField(key, ALLOWED_DELETE_FILTERS, "delete filter");

  const conditions = keys.map((k, idx) => `${k} = $${idx + 1}`).join(" AND ");

  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $${keys.length + 1}
     WHERE ${conditions} AND is_deleted = false`,
    [...Object.values(filters), meta.deleted_by || null]
  );
};

// --- Legacy default export (Task app + auth middleware) -----------
const User = {
  tableName: TABLE,

  async getAll(opts = {}) {
    const result = await findUsers({
      page: opts.page,
      limit: opts.limit,
      sort: { by: opts.sortBy || "id", order: opts.order || "ASC" },
      search: opts.search,
      filters: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.type ? { type: opts.type } : {}),
      },
    });
    return result.data;
  },

  async count(opts = {}) {
    const result = await findUsers({
      page: 1,
      limit: 1,
      search: opts.search,
      filters: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.type ? { type: opts.type } : {}),
      },
    });
    return result.total;
  },

  getById: (id) => findUser({ id }),
  getByUsername: (username) => findUserByUsernameInsensitive(username),
  create: (data) => insertUser(data),
  update: async (id, data) => {
    const [row] = await updateUsers(data, { id });
    return row;
  },
  delete: (id, deleted_by) => deleteUsers({ id }, { deleted_by }),

  async isManager(id) {
    const user = await findUser({ id });
    return user?.designation_name?.toLowerCase() === "manager";
  },

  async isExecutive(id) {
    const user = await findUser({ id });
    const d = String(user?.designation_name ?? "").toLowerCase().trim();
    if (!d || d === "manager") return false;
    return d === "executive" || d === "executive assistant" || d.includes("executive");
  },
};

export default User;
