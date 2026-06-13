import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { getTriggerLabel, getAppTypeLabel, APP_TYPE } from "../config/inboxConfig.js";

const Inbox = {
  async create({ user_id, app_type = APP_TYPE.TASK, task_id, trigger_key, title, body, link_url }) {
    const rows = await dbQuery(
      `INSERT INTO ${M.INBOX} (user_id, app_type, task_id, trigger_key, title, body, link_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING inbox_id, user_id, app_type, task_id, trigger_key, title, body, link_url, is_read,
         TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') AS created_at`,
      [user_id, app_type, task_id ?? null, trigger_key, title, body ?? "", link_url ?? "/"]
    );
    return formatRow(rows[0]);
  },

  async listUnread(userId, { limit = 20, offset = 0, app_type = null } = {}) {
    const params = [userId];
    let where = `user_id = ? AND is_read = FALSE`;
    if (app_type) {
      where += ` AND app_type = ?`;
      params.push(app_type);
    }
    params.push(Number(limit), Number(offset));

    const rows = await dbQuery(
      `SELECT inbox_id, user_id, app_type, task_id, trigger_key, title, body, link_url, is_read,
              TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM ${M.INBOX}
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      params
    );
    return rows.map(formatRow);
  },

  async countUnread(userId, { app_type = null } = {}) {
    const params = [userId];
    let where = `user_id = ? AND is_read = FALSE`;
    if (app_type) {
      where += ` AND app_type = ?`;
      params.push(app_type);
    }
    const rows = await dbQuery(
      `SELECT COUNT(*)::int AS total FROM ${M.INBOX} WHERE ${where}`,
      params
    );
    return rows[0]?.total ?? 0;
  },

  async markRead(inboxId, userId) {
    await dbQuery(
      `UPDATE ${M.INBOX} SET is_read = TRUE WHERE inbox_id = ? AND user_id = ?`,
      [inboxId, userId]
    );
  },

  async markAllRead(userId, { app_type = null } = {}) {
    const params = [userId];
    let where = `user_id = ? AND is_read = FALSE`;
    if (app_type) {
      where += ` AND app_type = ?`;
      params.push(app_type);
    }
    await dbQuery(`UPDATE ${M.INBOX} SET is_read = TRUE WHERE ${where}`, params);
  },
};

function formatRow(row) {
  if (!row) return null;
  return {
    inbox_id: row.inbox_id,
    user_id: row.user_id,
    app_type: row.app_type ?? APP_TYPE.TASK,
    app_type_label: getAppTypeLabel(row.app_type),
    task_id: row.task_id,
    trigger: row.trigger_key,
    trigger_label: getTriggerLabel(row.trigger_key),
    title: row.title,
    body: row.body ?? "",
    url: row.link_url ?? "/",
    is_read: !!row.is_read,
    created_at: row.created_at,
  };
}

export default Inbox;
