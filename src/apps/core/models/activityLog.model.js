import dbQuery from "../../../config/db.js";
import { MST_TABLES as T } from "../../../config/dbTables.js";

const ActivityLog = {
  create: async ({ user_id, user_name, app_type, module, action_type, description, log_data, ip_address, user_agent, entity, entity_id }) => {
    let finalUserName = user_name;
    if (!finalUserName && user_id) {
      try {
        const [u] = await dbQuery(`SELECT name FROM ${T.USERS} WHERE id = $1 LIMIT 1`, [user_id]);
        if (u) finalUserName = u.name;
      } catch (err) {
        console.error("[ActivityLog.create] failed to fetch user name:", err.message);
      }
    }

    const sql = `
      INSERT INTO ${T.ACTIVITY_LOGS} 
      (user_id, user_name, app_type, module, action_type, description, log_data, ip_address, user_agent, entity, entity_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    const params = [
      user_id,
      finalUserName,
      app_type,
      module,
      action_type,
      description,
      log_data ? JSON.stringify(log_data) : null,
      ip_address,
      user_agent,
      entity,
      entity_id
    ];
    const result = await dbQuery(sql, params);
    return result[0];
  },

  getAll: async (options = {}) => {
    const { 
      user_id, app_type, module, action_type, search, 
      date_from, date_to, entity, entity_id, 
      page = 1, limit = 50, skipCount = false 
    } = options;

    const offset = (page - 1) * limit;
    const { whereClause, params } = buildActivityLogWhere({ user_id, app_type, module, action_type, search, date_from, date_to, entity, entity_id });

    const sql = `
      SELECT l.*
      FROM ${T.ACTIVITY_LOGS} l
      ${whereClause}
      ORDER BY l.created_at DESC 
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    
    const dataParams = [...params, limit, offset];
    const rows = await dbQuery(sql, dataParams);

    let total = 0;
    if (!skipCount) {
      const countSql = `SELECT COUNT(*) FROM ${T.ACTIVITY_LOGS} l ${whereClause}`;
      const countRes = await dbQuery(countSql, params);
      total = parseInt(countRes[0].count);
    }

    return { data: rows, total };
  }
};

function buildActivityLogWhere({ user_id, app_type, module, action_type, search, date_from, date_to, entity, entity_id }) {
  const params = [];
  const conditions = ["1=1"];

  if (user_id) {
    conditions.push(`l.user_id = $${params.length + 1}`);
    params.push(user_id);
  }
  if (app_type) {
    conditions.push(`l.app_type = $${params.length + 1}`);
    params.push(app_type);
  }
  if (module) {
    conditions.push(`l.module = $${params.length + 1}`);
    params.push(module);
  }
  if (action_type) {
    conditions.push(`l.action_type = $${params.length + 1}`);
    params.push(action_type);
  }
  if (entity) {
    conditions.push(`l.entity = $${params.length + 1}`);
    params.push(entity);
  }
  if (entity_id) {
    conditions.push(`l.entity_id = $${params.length + 1}`);
    params.push(entity_id);
  }
  if (search) {
    const s = `%${search}%`;
    conditions.push(`(l.description ILIKE $${params.length + 1} OR l.module ILIKE $${params.length + 2} OR l.user_name ILIKE $${params.length + 3})`);
    params.push(s, s, s);
  }
  if (date_from) {
    conditions.push(`l.created_at >= $${params.length + 1}`);
    params.push(date_from);
  }
  if (date_to) {
    conditions.push(`l.created_at <= $${params.length + 1}`);
    params.push(date_to);
  }

  return {
    whereClause: `WHERE ${conditions.join(" AND ")}`,
    params
  };
}

export default ActivityLog;
