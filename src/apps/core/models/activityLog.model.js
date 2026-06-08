import dbQuery from "../../../config/db.js";
import { MST_TABLES as T } from "../../../config/dbTables.js";

const ActivityLog = {
  create: async ({ user_id, app_type, module, action_type, description, log_data, ip_address, user_agent, entity, entity_id }) => {
    const sql = `
      INSERT INTO ${T.ACTIVITY_LOGS} 
      (user_id, app_type, module, action_type, description, log_data, ip_address, user_agent, entity, entity_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
    const params = [
      user_id,
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

  getAll: async ({ user_id, app_type, module, action_type, search, date_from, date_to, entity, entity_id, page = 1, limit = 20 }) => {
    const offset = (page - 1) * limit;
    const params = [];
    let sql = `
      SELECT l.*, u.name as user_name, u.username as user_username
      FROM ${T.ACTIVITY_LOGS} l
      LEFT JOIN ${T.USERS} u ON l.user_id = u.id
      WHERE 1=1
    `;

    if (user_id) {
      sql += ` AND l.user_id = $${params.length + 1}`;
      params.push(user_id);
    }
    if (app_type) {
      sql += ` AND l.app_type = $${params.length + 1}`;
      params.push(app_type);
    }
    if (module) {
      sql += ` AND l.module = $${params.length + 1}`;
      params.push(module);
    }
    if (action_type) {
      sql += ` AND l.action_type = $${params.length + 1}`;
      params.push(action_type);
    }
    if (entity) {
      sql += ` AND l.entity = $${params.length + 1}`;
      params.push(entity);
    }
    if (entity_id) {
      sql += ` AND l.entity_id = $${params.length + 1}`;
      params.push(entity_id);
    }
    if (search) {
      sql += ` AND (l.description ILIKE $${params.length + 1} OR l.module ILIKE $${params.length + 2} OR u.name ILIKE $${params.length + 3})`;
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (date_from) {
      sql += ` AND l.created_at >= $${params.length + 1}`;
      params.push(date_from);
    }
    if (date_to) {
      sql += ` AND l.created_at <= $${params.length + 1}`;
      params.push(date_to);
    }

    sql += ` ORDER BY l.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    return await dbQuery(sql, params);
  },

  count: async ({ user_id, app_type, module, action_type, search, date_from, date_to, entity, entity_id }) => {
    const params = [];
    let sql = `
      SELECT COUNT(*) 
      FROM ${T.ACTIVITY_LOGS} l
      LEFT JOIN ${T.USERS} u ON l.user_id = u.id
      WHERE 1=1
    `;

    if (user_id) {
      sql += ` AND l.user_id = $${params.length + 1}`;
      params.push(user_id);
    }
    if (app_type) {
      sql += ` AND l.app_type = $${params.length + 1}`;
      params.push(app_type);
    }
    if (module) {
      sql += ` AND l.module = $${params.length + 1}`;
      params.push(module);
    }
    if (action_type) {
      sql += ` AND l.action_type = $${params.length + 1}`;
      params.push(action_type);
    }
    if (entity) {
      sql += ` AND l.entity = $${params.length + 1}`;
      params.push(entity);
    }
    if (entity_id) {
      sql += ` AND l.entity_id = $${params.length + 1}`;
      params.push(entity_id);
    }
    if (search) {
      sql += ` AND (l.description ILIKE $${params.length + 1} OR l.module ILIKE $${params.length + 2} OR u.name ILIKE $${params.length + 3})`;
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (date_from) {
      sql += ` AND l.created_at >= $${params.length + 1}`;
      params.push(date_from);
    }
    if (date_to) {
      sql += ` AND l.created_at <= $${params.length + 1}`;
      params.push(date_to);
    }

    const result = await dbQuery(sql, params);
    return parseInt(result[0].count);
  }
};

export default ActivityLog;
