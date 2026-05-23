import dbQuery from "../config/db.js";

// ─── Create Log ───────────────────────────────────────────────────
export const createLog = async ({ user_id, user_type, action, entity, entity_id = null, details = {}, ip_address = null, user_agent = null }) => {
  await dbQuery(
    `INSERT INTO activity_logs
      (user_id, user_type, action, entity, entity_id, details, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [user_id, user_type, action, entity, entity_id, JSON.stringify(details), ip_address, user_agent]
  );
};

// ─── Find Logs ────────────────────────────────────────────────────
export const findLogs = async (options = {}, req_user = {}) => {
  const {filters = {}, search  = null, sort = { by: "created_at", order: "DESC" }, page = 1, limit = 20, fields = ["al.*"]} = options;

  const values = [];
  let i = 1;
  const conditions = [];

  // Permission-based date restriction (can_view_days)
  if (options.permission?.can_view_days > 0) {
    conditions.push(`al.created_at >= CURRENT_DATE - INTERVAL '${options.permission.can_view_days - 1} days'`);
  }

  if (req_user.type === "user") {
    // always own logs
    values.push(req_user.id);
    conditions.push(`al.user_id = $${i++}`);
  }

  if (req_user.type === "admin") {
    // default → own logs
    if (!filters.user_id && filters.user_id !== "all") {
      values.push(req_user.id);
      conditions.push(`al.user_id = $${i++}`);
    }

    // if admin selects "all"
    if (filters.user_id === "all") {
      delete filters.user_id;
    }
  }

  // FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (key === "from_date" || key === "fromDate") {
      values.push(val);
      conditions.push(`al.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date" || key === "toDate") {
      values.push(val);
      conditions.push(`al.created_at <= $${i++}`);
      continue;
    }
    if (req_user.type === "admin" && key === "user_type") continue;
    if (val === null) {
      conditions.push(`al.${key} IS NULL`);
    } else if (Array.isArray(val)) {
      const placeholders = val.map(() => `$${i++}`).join(", ");
      values.push(...val);
      conditions.push(`al.${key} IN (${placeholders})`);
    } else {
      values.push(val);
      conditions.push(`al.${key} = $${i++}`);
    }
  }

  // SEARCH
  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(
      al.action ILIKE $${idx} OR
      al.entity ILIKE $${idx} OR
      al.user_type ILIKE $${idx}
    )`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // SAFE SORT
  const allowedSortFields = ["created_at", "action", "entity", "user_type"];

  const sortBy = allowedSortFields.includes(sort.by) ? `al.${sort.by}` : "al.created_at";

  const sortOrder = ["ASC", "DESC"].includes(sort.order?.toUpperCase()) ? sort.order.toUpperCase() : "DESC";

  const orderClause = `ORDER BY ${sortBy} ${sortOrder}`;

  // PAGINATION
  const safePage = Math.max(1, parseInt(page));
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (safePage - 1) * safeLimit;

  values.push(safeLimit, offset);
  const paginationClause = `LIMIT $${i++} OFFSET $${i++}`;

  // COUNT
  const countValues = values.slice(0, values.length - 2);

  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) FROM activity_logs al ${whereClause}`,
    countValues
  );

  // DATA QUERY (fields used)
  const rows = await dbQuery(
    `SELECT ${fields.join(", ")}
     FROM activity_logs al
     LEFT JOIN users u ON u.id = al.user_id
     ${whereClause}
     ${orderClause}
     ${paginationClause}`,
    values
  );

  return {
    data: rows,
    total: parseInt(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(parseInt(count) / safeLimit)
  };
};

export const findLogById = async (id, req_user = {}) => {
  const filters = { id };
  const result = await findLogs({ filters, page: 1, limit: 1 }, req_user);
  return result.data?.[0] ?? null;
};

export const updateLogById = async (id, fields = {}) => {
  const fieldKeys = Object.keys(fields);
  if (!fieldKeys.length) return null;

  const setClause = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const values = [...Object.values(fields), id];
  const [row] = await dbQuery(
    `UPDATE activity_logs
     SET ${setClause}
     WHERE id = $${values.length} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row ?? null;
};

export const deleteLogById = async (id, deleted_by = null) => {
  const [row] = await dbQuery(
    `UPDATE activity_logs
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE id = $1 AND is_deleted = false
     RETURNING *`,
    [id, deleted_by]
  );
  return row ?? null;
};