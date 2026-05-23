import dbQuery from "../config/db.js";

const ALLOWED_LIST_FILTER_FIELDS = ["id", "module_id", "permission_type", "is_active", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["id", "module_id", "title", "created_at", "updated_at", "permission_type", "is_active", "approved", "approved_at"];
const ALLOWED_UPDATE_FIELDS = ["module_id", "title", "description", "video_url", "permission_type", "is_active", "updated_by", "updated_at"];
const ALLOWED_FIND_KEYS = ["id", "module_id"];
const ALLOWED_DELETE_FILTER_KEYS = ["id"];

const TV_FROM = `FROM training_videos tv
  LEFT JOIN users u_cr ON tv.created_by = u_cr.id
  LEFT JOIN users u_ap ON tv.approved_by = u_ap.id
  LEFT JOIN users u_up ON tv.updated_by = u_up.id`;

const assertField = (key, list, ctx = "field") => {
  if (!list.includes(key)) throw new Error(`Invalid ${ctx}: "${key}"`);
};

// ─── Get all training videos ─────────────────────────────────────
export const findTrainingVideos = async ({
  filters = {},
  search,
  sort = { by: "created_at", order: "DESC" },
  page = 1,
  limit = 10,
  includeEmptyPermission = false,
  module_slug = null,
  user_id = null,
  user_type = null,
  is_views = false,
}) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(5000, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (safePage - 1) * safeLimit;

  const rawSortBy = sort?.by || "created_at";
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(rawSortBy) ? rawSortBy : "created_at";
  const safeOrder = sort?.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";

  const values = [];
  let i = 1;
  const whereClauses = ["tv.is_deleted = false"];

  if (is_views && module_slug) {
    const [moduleRow] = await dbQuery(`SELECT id FROM modules WHERE name = $1`, [module_slug]);
    if (!moduleRow) return { data: [], total_count: 0 };

    values.push(moduleRow.id);
    whereClauses.push(`tv.module_id = $${i++}`);

    if (user_type !== "super_admin" && user_id) {
      const [perm] = await dbQuery(
        `SELECT can_view, can_add, can_edit, can_delete, can_authorize
         FROM user_permissions
         WHERE user_id = $1 AND module_id = $2 AND is_deleted = false`,
        [user_id, moduleRow.id]
      );

      if (!perm) return { data: [], total_count: 0 };

      const allowedActions = [];
      if (perm.can_view) allowedActions.push("view");
      if (perm.can_add) allowedActions.push("add");
      if (perm.can_edit) allowedActions.push("edit");
      if (perm.can_delete) allowedActions.push("delete");
      if (perm.can_authorize) allowedActions.push("authorize");

      if (allowedActions.length === 0) return { data: [], total_count: 0 };

      const placeholders = allowedActions.map(() => `$${i++}`).join(", ");
      values.push(...allowedActions);
      whereClauses.push(`(tv.permission_type IN (${placeholders}) OR tv.permission_type IS NULL)`);
    }
  }

  Object.keys(filters).forEach((key) => {
    const val = filters[key];
    if (val === undefined || val === null) return;
    if (!ALLOWED_LIST_FILTER_FIELDS.includes(key)) return;

    if (key === "from_date") {
      values.push(val);
      whereClauses.push(`tv.created_at >= $${i++}`);
      return;
    }
    if (key === "to_date") {
      values.push(val);
      whereClauses.push(`tv.created_at <= $${i++}`);
      return;
    }
    if (key === "permission_type" && Array.isArray(val)) {
      const placeholders = val.map(() => `$${i++}`).join(", ");
      values.push(...val);
      if (includeEmptyPermission) {
        whereClauses.push(`(tv.permission_type IN (${placeholders}) OR tv.permission_type IS NULL)`);
      } else {
        whereClauses.push(`tv.permission_type IN (${placeholders})`);
      }
      return;
    }
    values.push(val);
    whereClauses.push(`tv.${key} = $${i++}`);
  });

  if (search) {
    values.push(`%${search}%`);
    whereClauses.push(`tv.title ILIKE $${i++}`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const countQuery = `SELECT COUNT(*)::int AS count ${TV_FROM} ${whereSql}`;
  const totalResult = await dbQuery(countQuery, values);
  const totalCount = parseInt(totalResult[0]?.count ?? 0, 10);

  const dataValues = [...values, safeLimit, offset];
  const limPh = `$${i++}`;
  const offPh = `$${i++}`;
  const dataQuery = `
    SELECT tv.*, u_cr.name AS created_by_name, u_ap.name AS approved_by_name, u_up.name AS updated_by_name
    ${TV_FROM}
    ${whereSql}
    ORDER BY tv.${safeSortBy} ${safeOrder}
    LIMIT ${limPh} OFFSET ${offPh}
  `;

  const data = await dbQuery(dataQuery, dataValues);

  return {
    data,
    total_count: totalCount,
    current_page: safePage,
    last_page: Math.ceil(totalCount / safeLimit) || 1,
  };
};

// ─── Get single training video ──────────────────────────────────
export const findTrainingVideo = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (keys.length === 0) return null;
  for (const key of keys) assertField(key, ALLOWED_FIND_KEYS, "filter field");

  const conditions = keys.map((key, idx) => `tv.${key} = $${idx + 1}`).join(" AND ");
  const [video] = await dbQuery(
    `SELECT tv.*, u_cr.name AS created_by_name, u_ap.name AS approved_by_name, u_up.name AS updated_by_name
     ${TV_FROM}
     WHERE tv.is_deleted = false AND ${conditions}
     LIMIT 1`,
    Object.values(filters)
  );
  return video ?? null;
};

// ─── Insert a new training video ────────────────────────────────
export const insertTrainingVideo = async ({
  module_id,
  title,
  description,
  video_url,
  permission_type,
  created_by,
  approved = false,
  approved_by = null,
  approved_at = null,
}) => {
  const [video] = await dbQuery(
    `INSERT INTO training_videos
      (module_id, title, description, video_url, permission_type, created_by, approved, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [module_id, title, description, video_url, permission_type, created_by, approved, approved_by, approved_at]
  );
  return video;
};

// ─── Mark video approved (RBAC: authorize action) ─────────────────
export const approveTrainingVideoById = async (id, approverUserId) => {
  const [row] = await dbQuery(
    `UPDATE training_videos
     SET approved = true,
         approved_by = $2,
         approved_at = NOW()
     WHERE id = $1 AND is_deleted = false AND approved = false
     RETURNING *`,
    [id, approverUserId]
  );
  return row ?? null;
};

// ─── Update a training video ───────────────────────────────────
export const updateTrainingVideo = async (fields = {}, filters = {}) => {
  const fieldKeys = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (fieldKeys.length === 0 || filterKeys.length === 0) return null;
  for (const k of fieldKeys) assertField(k, ALLOWED_UPDATE_FIELDS, "update field");
  for (const k of filterKeys) assertField(k, ALLOWED_DELETE_FILTER_KEYS, "filter field");

  const setClause = fieldKeys.map((key, idx) => `${key} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((key, idx) => `${key} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const vals = [...Object.values(fields), ...Object.values(filters)];

  const [updated] = await dbQuery(
    `UPDATE training_videos SET ${setClause} WHERE ${whereClause} AND is_deleted = false RETURNING *`,
    vals
  );
  return updated ?? null;
};

// ─── Soft-delete a training video ──────────────────────────────
export const deleteTrainingVideo = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  if (keys.length === 0) throw new Error("No filters provided");
  for (const k of keys) assertField(k, ALLOWED_DELETE_FILTER_KEYS, "delete filter");

  const conditions = keys.map((key, idx) => `${key} = $${idx + 1}`).join(" AND ");
  await dbQuery(
    `UPDATE training_videos SET is_deleted = true, deleted_at = NOW(), deleted_by = $${keys.length + 1}
     WHERE ${conditions} AND is_deleted = false`,
    [...Object.values(filters), meta.deleted_by ?? null]
  );
};
