import dbQuery from "../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../config/db/dbTables.js";

const TABLE = M.NOTIFICATION_LOGS;

export const insertNotificationLog = async ({
  template_id,
  module_id,
  record_id,
  action,
  recipient_user_id,
  channel,
  recipient,
  title,
  message,
  status,
  error_detail,
  inbox_id,
  triggered_by,
}) => {
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
      (template_id, module_id, record_id, action, recipient_user_id, channel, recipient,
       title, message, status, error_detail, inbox_id, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      template_id ?? null,
      module_id ?? null,
      record_id != null ? String(record_id).slice(0, 100) : null,
      action,
      recipient_user_id ?? null,
      channel,
      recipient ?? null,
      title ?? null,
      message ?? null,
      status,
      error_detail ?? null,
      inbox_id ?? null,
      triggered_by ?? null,
    ]
  );
  return row;
};

/** Bulk insert delivery rows (module notify — many recipients). */
export async function insertNotificationLogsBatch(entries = []) {
  if (!entries.length) return [];
  const rows = [];
  const CHUNK = 80;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const values = [];
    const tuples = chunk.map((e, j) => {
      const base = j * 13;
      values.push(
        e.template_id ?? null,
        e.module_id ?? null,
        e.record_id != null ? String(e.record_id).slice(0, 100) : null,
        e.action,
        e.recipient_user_id ?? null,
        e.channel,
        e.recipient ?? null,
        e.title ?? null,
        e.message ?? null,
        e.status,
        e.error_detail ?? null,
        e.inbox_id ?? null,
        e.triggered_by ?? null
      );
      const p = Array.from({ length: 13 }, (_, k) => `$${base + k + 1}`);
      return `(${p.join(", ")})`;
    });
    const inserted = await dbQuery(
      `INSERT INTO ${TABLE}
        (template_id, module_id, record_id, action, recipient_user_id, channel, recipient,
         title, message, status, error_detail, inbox_id, triggered_by)
       VALUES ${tuples.join(", ")}
       RETURNING id`,
      values
    );
    rows.push(...inserted);
  }
  return rows;
};

export const findNotificationLogs = async ({
  page = 1,
  limit = 20,
  template_id,
  module_id,
  action,
  channel,
  status,
  search,
  from_date,
  to_date,
  order = "desc",
} = {}) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;
  const sortOrder = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";

  const values = [];
  const where = [];
  const push = (sql, val) => {
    values.push(val);
    where.push(sql.replace("?", `$${values.length}`));
  };

  if (template_id) push("l.template_id = ?", template_id);
  if (module_id) push("l.module_id = ?", module_id);
  if (action) push("l.action = ?", action);
  if (channel) push("l.channel = ?", channel);
  if (status) push("l.status = ?", status);
  if (from_date) push("l.sent_at >= ?::date", from_date);
  if (to_date) push("l.sent_at < (?::date + INTERVAL '1 day')", to_date);
  if (search && String(search).trim()) {
    values.push(`%${String(search).trim()}%`);
    const p = `$${values.length}`;
    where.push(
      `(u.name ILIKE ${p} OR l.recipient ILIKE ${p} OR l.message ILIKE ${p} OR l.title ILIKE ${p}
        OR t.name ILIKE ${p} OR m.label ILIKE ${p} OR l.record_id ILIKE ${p} OR l.triggered_by ILIKE ${p})`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = `
    FROM ${TABLE} l
    LEFT JOIN ${M.NOTIFICATION_TEMPLATES} t ON t.id = l.template_id
    LEFT JOIN ${M.MODULES} m ON m.id = l.module_id
    LEFT JOIN ${M.USERS} u ON u.id = l.recipient_user_id
    LEFT JOIN ${M.INBOX} i ON i.inbox_id = l.inbox_id
  `;

  const [countRow] = await dbQuery(`SELECT COUNT(*)::int AS total ${from} ${whereSql}`, values);

  const items = await dbQuery(
    `SELECT l.id, l.template_id, l.module_id, l.record_id, l.action, l.recipient_user_id,
            l.channel, l.recipient, l.title, l.message, l.status, l.error_detail, l.inbox_id,
            l.triggered_by,
            TO_CHAR(l.sent_at, 'YYYY-MM-DD HH24:MI:SS') AS sent_at,
            COALESCE(i.is_read, false) AS is_read,
            t.name AS template_name,
            m.label AS module_label,
            m.name AS module_name,
            u.name AS recipient_name
     ${from} ${whereSql}
     ORDER BY l.sent_at ${sortOrder}, l.id ${sortOrder}
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, safeLimit, offset]
  );

  return { items, total: countRow?.total ?? 0, page: safePage, limit: safeLimit };
};
