import dbQuery from "../shared/db.js";
import { MST_TABLES as M, TASK_TABLES as T } from "../../../config/dbTables.js";

const APP_TYPE = "task";
const MODULE = "notifications";
const ACTION = "NOTIFICATION_SENT";

function parsePage(value, fallback = 1) {
  const n = parseInt(String(Array.isArray(value) ? value[0] : value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseLimit(value, fallback = 20, max = 100) {
  const n = parseInt(String(Array.isArray(value) ? value[0] : value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

const NotificationLog = {
  async create({ task_id, user_id, template_key, channel, recipient, message, status, error_detail }) {
    const log_data = {
      template_key,
      channel,
      recipient,
      status: status ?? "sent",
      error_detail: error_detail ?? null,
      message: message?.slice(0, 500) ?? "",
      task_id: task_id ?? null,
    };

    const description = `${template_key || "notify"} to ${recipient || "user"} (${status ?? "sent"})`;

    await dbQuery(
      `INSERT INTO ${M.ACTIVITY_LOGS}
        (user_id, app_type, module, action_type, description, log_data, entity, entity_id)
       VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)`,
      [
        user_id ?? null,
        APP_TYPE,
        MODULE,
        ACTION,
        description,
        JSON.stringify(log_data),
        task_id ? "task" : null,
        task_id ?? null,
      ]
    );
  },

  async getAll({ page = 1, limit = 20, template_key, channel, search }) {
    const safePage = parsePage(page);
    const safeLimit = parseLimit(limit);
    const offset = (safePage - 1) * safeLimit;

    const where = [
      `l.app_type = ?`,
      `l.module = ?`,
      `l.action_type = ?`,
    ];
    const params = [APP_TYPE, MODULE, ACTION];

    if (template_key) {
      where.push(`l.log_data->>'template_key' = ?`);
      params.push(template_key);
    }
    if (channel) {
      where.push(`l.log_data->>'channel' = ?`);
      params.push(channel);
    }
    if (search) {
      where.push(`(l.description ILIKE ? OR u.name ILIKE ? OR t.title ILIKE ? OR l.log_data::text ILIKE ?)`);
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const items = await dbQuery(
      `SELECT
         l.id AS log_id,
         l.entity_id AS task_id,
         l.user_id,
         l.log_data,
         TO_CHAR(l.created_at, 'YYYY-MM-DD HH24:MI') AS sent_at,
         u.name AS user_name,
         t.title AS task_title
       FROM ${M.ACTIVITY_LOGS} l
       LEFT JOIN ${M.USERS} u ON u.id = l.user_id
       LEFT JOIN ${T.TASKS} t ON t.task_id = l.entity_id
       WHERE ${where.join(" AND ")}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    const parsed = items.map((row) => {
      const meta = typeof row.log_data === "object" ? row.log_data : {};
      return {
        log_id: row.log_id,
        task_id: row.task_id,
        user_id: row.user_id,
        template_key: meta.template_key,
        channel: meta.channel,
        recipient: meta.recipient,
        message: meta.message,
        status: meta.status,
        error_detail: meta.error_detail,
        sent_at: row.sent_at,
        user_name: row.user_name,
        task_title: row.task_title,
      };
    });

    const countRows = await dbQuery(
      `SELECT COUNT(*) AS total
       FROM ${M.ACTIVITY_LOGS} l
       LEFT JOIN ${M.USERS} u ON u.id = l.user_id
       LEFT JOIN ${T.TASKS} t ON t.task_id = l.entity_id
       WHERE ${where.join(" AND ")}`,
      params
    );

    return {
      items: parsed,
      total: Number(countRows[0]?.total ?? 0),
      page: safePage,
      limit: safeLimit,
    };
  },
};

export default NotificationLog;
