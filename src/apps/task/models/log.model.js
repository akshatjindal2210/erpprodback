import dbQuery from "../shared/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

const UserActivityLog = {

  getAll: async ({ search = "", page = 1, limit = 10, sortBy = "created_at", order = "DESC",
                   dateFrom, dateTo, targetUserId, targetUserType }) => {
    const offset = (Number(page) - 1) * Number(limit);
    const params = [];

    let sql = `
      SELECT
        l.id, l.action_type AS action, l.module, l.description, l.user_type,
        l.log_data, l.created_at, l.user_id,
        COALESCE(u.name, 'System/Deleted User') AS user_name,
        u.username AS user_username
      FROM task_users_logs l
      LEFT JOIN ${M.USERS} u ON u.id = l.user_id
      WHERE 1=1
    `;

    if (targetUserId)   { sql += ` AND l.user_id = ?`;    params.push(targetUserId);   }
    if (targetUserType) { sql += ` AND l.user_type = ?`;  params.push(targetUserType); }

    if (search) {
      sql += ` AND (l.action_type LIKE ? OR l.description LIKE ? OR u.name LIKE ? OR u.username LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    if (dateFrom) { sql += ` AND l.created_at >= ?`; params.push(`${dateFrom} 00:00:00`); }
    if (dateTo)   { sql += ` AND l.created_at <= ?`; params.push(`${dateTo} 23:59:59`);   }

    const allowed  = ["id", "action_type", "module", "created_at"];
    const safeSort = allowed.includes(sortBy) ? sortBy : "created_at";
    const safeOrd  = order.toUpperCase() === "ASC" ? "ASC" : "DESC";

    sql += ` ORDER BY l.${safeSort} ${safeOrd} LIMIT ? OFFSET ?`;
    params.push(Number(limit), offset);

    return dbQuery(sql, params);
  },

  count: async ({ search = "", dateFrom, dateTo, targetUserId, targetUserType }) => {
    const params = [];
    let sql = `SELECT COUNT(*) AS total FROM task_users_logs l LEFT JOIN ${M.USERS} u ON u.id = l.user_id WHERE 1=1`;

    if (targetUserId)   { sql += ` AND l.user_id = ?`;   params.push(targetUserId);   }
    if (targetUserType) { sql += ` AND l.user_type = ?`; params.push(targetUserType); }

    if (search) {
      const s = `%${search}%`;
      sql += ` AND (l.action_type LIKE ? OR l.description LIKE ? OR u.name LIKE ? OR u.username LIKE ?)`;
      params.push(s, s, s, s);
    }

    if (dateFrom) { sql += ` AND l.created_at >= ?`; params.push(`${dateFrom} 00:00:00`); }
    if (dateTo)   { sql += ` AND l.created_at <= ?`; params.push(`${dateTo} 23:59:59`);   }

    const result = await dbQuery(sql, params);
    return result[0]?.total ?? 0;
  },

  getById: async (id) => {
    const result = await dbQuery(`
      SELECT l.*, u.name AS user_name, u.username AS user_username
      FROM task_users_logs l
      LEFT JOIN ${M.USERS} u ON u.id = l.user_id
      WHERE l.id = ?
    `, [id]);
    return result[0] || null;
  },

  create: async ({ user_id, action_type, module, description, user_type, log_data }) => {
    const dataToStore = (log_data && typeof log_data === "object")
      ? JSON.stringify(log_data)
      : log_data;

    return dbQuery(
      `INSERT INTO task_users_logs (user_id, action_type, module, description, user_type, log_data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user_id, action_type, module, description, user_type, dataToStore]
    );
  },

  delete: async (id) => {
    return dbQuery(`DELETE FROM task_users_logs WHERE id = ?`, [id]);
  },

  bulkDelete: async (ids = []) => {
    if (!ids.length) return { affectedRows: 0 };
    const placeholders = ids.map(() => "?").join(",");
    return dbQuery(`DELETE FROM task_users_logs WHERE id IN (${placeholders})`, ids);
  },
};

export default UserActivityLog;