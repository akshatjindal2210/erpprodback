import dbQuery from "../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../config/db/dbTables.js";

const VALID_STATUS = new Set(["sent", "failed", "received", "read"]);

function formatRow(row) {
  if (!row) return null;
  return {
    push_log_id: row.push_log_id,
    tracking_id: row.tracking_id,
    user_id: row.user_id,
    user_name: row.user_name,
    subscription_id: row.subscription_id,
    device_id: row.device_id,
    device_name: row.device_name,
    inbox_id: row.inbox_id,
    title: row.title,
    body: row.body,
    status: row.status,
    error_detail: row.error_detail,
    sent_at: row.sent_at,
    received_at: row.received_at,
    read_at: row.read_at,
    received_client_ip: row.received_client_ip ?? null,
    received_on_company_network:
      row.received_on_company_network === true
        ? true
        : row.received_on_company_network === false
          ? false
          : null,
    created_at: row.created_at,
  };
}

const PushDeliveryLog = {
  async create({
    tracking_id,
    user_id = null,
    user_name = null,
    subscription_id = null,
    device_id = null,
    device_name = null,
    inbox_id = null,
    template_key = null,
    channel = "pwa_push",
    app_type = "task",
    title = "",
    body = "",
    status = "sent",
    error_detail = null,
    sent_at = null,
  }) {
    const safeStatus = VALID_STATUS.has(status) ? status : "sent";
    const rows = await dbQuery(
      `INSERT INTO ${M.PUSH_DELIVERY_LOG}
         (tracking_id, user_id, user_name, subscription_id, device_id, device_name,
          inbox_id, template_key, channel, app_type, title, body, status, error_detail, sent_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       RETURNING push_log_id, tracking_id, user_id, user_name, subscription_id, device_id,
         device_name, inbox_id, template_key, channel, title, body, status, error_detail,
         TO_CHAR(sent_at, 'YYYY-MM-DD HH24:MI:SS') AS sent_at,
         TO_CHAR(received_at, 'YYYY-MM-DD HH24:MI:SS') AS received_at,
         TO_CHAR(read_at, 'YYYY-MM-DD HH24:MI:SS') AS read_at,
         TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
      [
        tracking_id,
        user_id,
        user_name,
        subscription_id,
        device_id,
        device_name,
        inbox_id,
        template_key,
        channel,
        app_type,
        title,
        body,
        safeStatus,
        error_detail,
        sent_at,
      ]
    );
    return formatRow(rows[0]);
  },

  async markReceived(tracking_id, { client_ip = null, on_company_network = null } = {}) {
    const rows = await dbQuery(
      `UPDATE ${M.PUSH_DELIVERY_LOG}
       SET status = 'received',
           received_at = COALESCE(received_at, CURRENT_TIMESTAMP),
           received_client_ip = COALESCE(received_client_ip, ?),
           received_on_company_network = COALESCE(received_on_company_network, ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE tracking_id = ? AND status IN ('sent', 'received')
       RETURNING push_log_id, tracking_id, status, received_client_ip, received_on_company_network,
         TO_CHAR(sent_at, 'YYYY-MM-DD HH24:MI:SS') AS sent_at,
         TO_CHAR(received_at, 'YYYY-MM-DD HH24:MI:SS') AS received_at,
         TO_CHAR(read_at, 'YYYY-MM-DD HH24:MI:SS') AS read_at`,
      [client_ip, on_company_network, tracking_id]
    );
    return formatRow(rows[0]);
  },

  async markRead(tracking_id, { client_ip = null, on_company_network = null } = {}) {
    const rows = await dbQuery(
      `UPDATE ${M.PUSH_DELIVERY_LOG}
       SET status = 'read',
           received_at = COALESCE(received_at, CURRENT_TIMESTAMP),
           read_at = COALESCE(read_at, CURRENT_TIMESTAMP),
           received_client_ip = COALESCE(received_client_ip, ?),
           received_on_company_network = COALESCE(received_on_company_network, ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE tracking_id = ? AND status IN ('sent', 'received', 'read')
       RETURNING push_log_id, tracking_id, status, received_client_ip, received_on_company_network,
         TO_CHAR(sent_at, 'YYYY-MM-DD HH24:MI:SS') AS sent_at,
         TO_CHAR(received_at, 'YYYY-MM-DD HH24:MI:SS') AS received_at,
         TO_CHAR(read_at, 'YYYY-MM-DD HH24:MI:SS') AS read_at`,
      [client_ip, on_company_network, tracking_id]
    );
    return formatRow(rows[0]);
  },

  async markReadByInbox(inboxId, userId) {
    if (!inboxId || !userId) return null;
    const rows = await dbQuery(
      `UPDATE ${M.PUSH_DELIVERY_LOG}
       SET status = 'read',
           received_at = COALESCE(received_at, CURRENT_TIMESTAMP),
           read_at = COALESCE(read_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE inbox_id = ? AND user_id = ? AND status IN ('sent', 'received')
       RETURNING push_log_id, tracking_id, inbox_id, status`,
      [inboxId, userId]
    );
    return rows.map(formatRow);
  },

  async markAllReadForUser(userId, { app_type = null } = {}) {
    if (!userId) return { count: 0 };
    const params = [userId];
    let appFilter = "";
    if (app_type) {
      appFilter = " AND app_type = ?";
      params.push(app_type);
    }
    const rows = await dbQuery(
      `UPDATE ${M.PUSH_DELIVERY_LOG}
       SET status = 'read',
           received_at = COALESCE(received_at, CURRENT_TIMESTAMP),
           read_at = COALESCE(read_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND status IN ('sent', 'received')${appFilter}
       RETURNING push_log_id`,
      params
    );
    return { count: rows.length };
  },

  async list({ page = 1, limit = 20, user_id, status, search } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (safePage - 1) * safeLimit;

    const where = ["1=1"];
    const params = [];

    if (user_id) {
      where.push("user_id = ?");
      params.push(Number(user_id));
    }
    if (status && VALID_STATUS.has(status)) {
      where.push("status = ?");
      params.push(status);
    }
    if (search) {
      where.push("(title ILIKE ? OR body ILIKE ? OR user_name ILIKE ? OR device_name ILIKE ?)");
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const items = await dbQuery(
      `SELECT push_log_id, tracking_id, user_id, user_name, subscription_id, device_id, device_name,
              inbox_id, title, body, status, error_detail,
              received_client_ip, received_on_company_network,
              TO_CHAR(sent_at, 'YYYY-MM-DD HH24:MI:SS') AS sent_at,
              TO_CHAR(received_at, 'YYYY-MM-DD HH24:MI:SS') AS received_at,
              TO_CHAR(read_at, 'YYYY-MM-DD HH24:MI:SS') AS read_at,
              TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM ${M.PUSH_DELIVERY_LOG}
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    const countRows = await dbQuery(
      `SELECT COUNT(*)::int AS total FROM ${M.PUSH_DELIVERY_LOG} WHERE ${where.join(" AND ")}`,
      params
    );

    return {
      items: items.map(formatRow),
      total: countRows[0]?.total ?? 0,
      page: safePage,
      limit: safeLimit,
    };
  },
};

export default PushDeliveryLog;
