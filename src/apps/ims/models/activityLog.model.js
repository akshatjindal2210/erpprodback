import dbQuery from "../../../config/db.js";
import { MST_TABLES as M, IMS_TABLES as T } from "../../../config/dbTables.js";

const TABLE = T.ACTIVITY_LOGS;

const ALLOWED_USER_TYPES = new Set(["super_admin", "admin", "user", "executive_assistant"]);
const ALLOWED_ACTIONS = new Set([
  "login",
  "logout",
  "create",
  "update",
  "delete",
  "view",
  "permission_change",
]);

function normalizeUserType(raw) {
  const t = String(raw ?? "user").toLowerCase();
  return ALLOWED_USER_TYPES.has(t) ? t : "user";
}

/** Numeric entity_id for DB; non-numeric refs (e.g. box_uid) go in details.entity_ref. */
function splitEntityId(entity_id, details = {}) {
  const base = details && typeof details === "object" ? { ...details } : {};
  if (entity_id == null || entity_id === "") {
    return { entityId: null, details: base };
  }
  const n = Number(entity_id);
  if (Number.isFinite(n)) {
    return { entityId: n, details: base };
  }
  return { entityId: null, details: { ...base, entity_ref: String(entity_id) } };
}

export const createLog = async (data) => {
  const {
    user_id = null,
    user_type = "user",
    action,
    entity,
    entity_id = null,
    details = {},
    ip_address = null,
    user_agent = null,
    created_by = null,
    approved = false,
    approved_by = null,
    approved_at = null,
  } = data;

  if (!action || !ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Invalid activity log action: ${action}`);
  }
  if (!entity || !String(entity).trim()) {
    throw new Error("Activity log entity is required");
  }

  const { entityId, details: mergedDetails } = splitEntityId(entity_id, details);
  const actorId = created_by ?? user_id ?? null;

  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (
       user_id, user_type, action, entity, entity_id, details,
       ip_address, user_agent, approved, approved_by, approved_at,
       created_by, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     RETURNING *`,
    [
      user_id,
      normalizeUserType(user_type),
      action,
      String(entity).slice(0, 50),
      entityId,
      JSON.stringify(mergedDetails),
      ip_address,
      user_agent,
      !!approved,
      approved_by,
      approved_at,
      actorId,
    ]
  );
  return row;
};

export const findLogs = async ({
  page = 1,
  limit = 10,
  sortBy = "created_at",
  order = "DESC",
  search,
  filters = {},
  includeDeleted = false,
}) => {
  const offset = (page - 1) * limit;
  const params = [];
  let sql = `
    SELECT l.*, u.name AS user_name
    FROM ${TABLE} l
    LEFT JOIN ${M.USERS} u ON l.user_id = u.id
    WHERE 1=1
  `;

  if (!includeDeleted) {
    sql += ` AND (l.is_deleted = false OR l.is_deleted IS NULL)`;
  }

  if (search) {
    sql += ` AND (
      l.action ILIKE $${params.length + 1}
      OR l.entity ILIKE $${params.length + 2}
      OR u.name ILIKE $${params.length + 3}
      OR l.details::text ILIKE $${params.length + 4}
    )`;
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }

  if (filters.fromDate) {
    sql += ` AND l.created_at >= $${params.length + 1}`;
    params.push(filters.fromDate);
  }

  if (filters.toDate) {
    sql += ` AND l.created_at <= $${params.length + 1}`;
    params.push(filters.toDate);
  }

  if (filters.userId != null && filters.userId !== "") {
    sql += ` AND l.user_id = $${params.length + 1}`;
    params.push(Number(filters.userId));
  }

  const safeSort = ["created_at", "id", "action", "entity"].includes(sortBy) ? sortBy : "created_at";
  const safeOrder = String(order).toUpperCase() === "ASC" ? "ASC" : "DESC";

  const countSql = `SELECT COUNT(*)::int AS total FROM (${sql}) AS t`;
  const countResult = await dbQuery(countSql, params);
  const total = countResult[0]?.total ?? 0;

  sql += ` ORDER BY l.${safeSort} ${safeOrder} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const rows = await dbQuery(sql, params);
  return {
    data: rows,
    total,
    page: Number(page),
    limit: Number(limit),
  };
};
