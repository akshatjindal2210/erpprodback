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

  async getAll({ page = 1, limit = 20, template_key, channel, status, search, order = "desc" }) {
    const safePage = parsePage(page);
    const safeLimit = parseLimit(limit);
    const offset = (safePage - 1) * safeLimit;
    const sortOrder = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";

    const pushWhere = [];
    const pushParams = [];
    const actWhere = [
      `l.app_type = ?`,
      `l.module = ?`,
      `l.action_type = ?`,
      `(l.log_data->>'channel' IN ('free', 'paid'))`,
    ];
    const actParams = [APP_TYPE, MODULE, ACTION];
    let includePush = true;
    let includeActivity = true;

    if (template_key) {
      pushWhere.push(`p.template_key = ?`);
      pushParams.push(template_key);
      actWhere.push(`l.log_data->>'template_key' = ?`);
      actParams.push(template_key);
    }

    if (channel) {
      if (channel === "pwa_push") {
        pushWhere.push(`COALESCE(p.channel, 'pwa_push') = ?`);
        pushParams.push("pwa_push");
        includeActivity = false;
      } else {
        includePush = false;
        actWhere.push(`l.log_data->>'channel' = ?`);
        actParams.push(channel);
      }
    }

    if (status) {
      pushWhere.push(`p.status = ?`);
      pushParams.push(status);
      actWhere.push(`l.log_data->>'status' = ?`);
      actParams.push(status);
      if (status === "received" || status === "read") {
        includeActivity = false;
      }
    }

    if (search) {
      const s = `%${search}%`;
      pushWhere.push(
        `(p.title ILIKE ? OR p.body ILIKE ? OR p.user_name ILIKE ? OR p.device_name ILIKE ? OR p.template_key ILIKE ?)`
      );
      pushParams.push(s, s, s, s, s);
      actWhere.push(`(l.description ILIKE ? OR u.name ILIKE ? OR t.title ILIKE ? OR l.log_data::text ILIKE ?)`);
      actParams.push(s, s, s, s);
    }

    const pushWhereSql = pushWhere.length ? `AND ${pushWhere.join(" AND ")}` : "";
    const actWhereSql = actWhere.join(" AND ");

    const unionParts = [];

    if (includePush) {
      unionParts.push(`
        SELECT
          p.push_log_id::text AS log_id,
          'push' AS log_source,
          p.tracking_id::text AS tracking_id,
          COALESCE(p.channel, 'pwa_push') AS channel,
          p.template_key,
          p.user_id,
          p.user_name,
          COALESCE(p.device_name, p.device_id, '') AS recipient,
          p.device_id,
          p.device_name,
          p.inbox_id,
          p.title,
          p.body,
          COALESCE(NULLIF(p.title, ''), p.body, '') AS message,
          p.status,
          p.error_detail,
          COALESCE(p.sent_at, p.created_at) AS sort_at,
          TO_CHAR(COALESCE(p.sent_at, p.created_at), 'YYYY-MM-DD HH24:MI:SS') AS sent_at,
          TO_CHAR(p.received_at, 'YYYY-MM-DD HH24:MI:SS') AS received_at,
          TO_CHAR(p.read_at, 'YYYY-MM-DD HH24:MI:SS') AS read_at,
          NULL::int AS task_id
        FROM ${M.PUSH_DELIVERY_LOG} p
        WHERE 1=1 ${pushWhereSql}
      `);
    }

    if (includeActivity) {
      unionParts.push(`
        SELECT
          l.id::text AS log_id,
          'whatsapp' AS log_source,
          NULL AS tracking_id,
          l.log_data->>'channel' AS channel,
          l.log_data->>'template_key' AS template_key,
          l.user_id,
          u.name AS user_name,
          l.log_data->>'recipient' AS recipient,
          NULL AS device_id,
          NULL AS device_name,
          NULL::int AS inbox_id,
          NULL AS title,
          l.log_data->>'message' AS body,
          l.log_data->>'message' AS message,
          l.log_data->>'status' AS status,
          l.log_data->>'error_detail' AS error_detail,
          l.created_at AS sort_at,
          TO_CHAR(l.created_at, 'YYYY-MM-DD HH24:MI:SS') AS sent_at,
          NULL AS received_at,
          NULL AS read_at,
          l.entity_id AS task_id
        FROM ${M.ACTIVITY_LOGS} l
        LEFT JOIN ${M.USERS} u ON u.id = l.user_id
        LEFT JOIN ${T.TASKS} t ON t.task_id = l.entity_id
        WHERE ${actWhereSql}
      `);
    }

    if (!unionParts.length) {
      return { items: [], total: 0, page: safePage, limit: safeLimit };
    }

    const combinedSql = unionParts.join(" UNION ALL ");
    const queryParams = [...pushParams, ...actParams, safeLimit, offset];
    const countParams = [...pushParams, ...actParams];

    const items = await dbQuery(
      `WITH combined AS (${combinedSql})
       SELECT * FROM combined
       ORDER BY sort_at ${sortOrder}
       LIMIT ? OFFSET ?`,
      queryParams
    );

    const countRows = await dbQuery(
      `WITH combined AS (${combinedSql})
       SELECT COUNT(*)::int AS total FROM combined`,
      countParams
    );

    return {
      items: items.map((row) => ({
        log_id: row.log_id,
        log_source: row.log_source,
        tracking_id: row.tracking_id,
        task_id: row.task_id,
        user_id: row.user_id,
        user_name: row.user_name,
        template_key: row.template_key,
        channel: row.channel,
        recipient: row.recipient,
        device_id: row.device_id,
        device_name: row.device_name,
        inbox_id: row.inbox_id,
        title: row.title,
        body: row.body,
        message: row.message,
        status: row.status,
        error_detail: row.error_detail,
        sent_at: row.sent_at,
        received_at: row.received_at,
        read_at: row.read_at,
      })),
      total: countRows[0]?.total ?? 0,
      page: safePage,
      limit: safeLimit,
    };
  },
};

export default NotificationLog;
