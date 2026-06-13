import dbQuery from "../shared/db.js";
import { TASK_TABLES as T } from "../../../config/dbTables.js";

function parseHistory(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const p = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function fmt(dt) {
  if (!dt) return null;
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return String(dt);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const TargetDate = {
  async getTaskRow(task_id) {
    const rows = await dbQuery(
      `SELECT current_target_at, target_dates_history FROM ${T.TASKS} WHERE task_id = ? LIMIT 1`,
      [task_id]
    );
    return rows[0] ?? null;
  },

  async getHistory(task_id) {
    const row = await this.getTaskRow(task_id);
    if (!row) return [];
    const history = parseHistory(row.target_dates_history);
    return [...history].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  },

  async getCurrent(task_id) {
    const row = await this.getTaskRow(task_id);
    if (!row?.current_target_at) return null;
    const history = parseHistory(row.target_dates_history);
    const current = history.find((h) => h.is_current) ?? history[history.length - 1];
    return {
      target_at: fmt(row.current_target_at),
      set_by: current?.set_by ?? null,
      set_by_name: current?.set_by_name ?? null,
      is_current: true,
      created_at: current?.created_at ?? fmt(row.current_target_at),
    };
  },

  async hasValidCurrent(task_id) {
    const rows = await dbQuery(
      `SELECT 1 FROM ${T.TASKS}
       WHERE task_id = ? AND current_target_at IS NOT NULL AND current_target_at > NOW()
       LIMIT 1`,
      [task_id]
    );
    return rows.length > 0;
  },

  async set(task_id, target_at, set_by, set_by_name) {
    const row = await this.getTaskRow(task_id);
    const history = parseHistory(row?.target_dates_history).map((h) => ({ ...h, is_current: false }));
    const entry = {
      target_at: fmt(target_at),
      set_by,
      set_by_name,
      is_current: true,
      created_at: fmt(new Date()),
    };
    history.push(entry);

    await dbQuery(
      `UPDATE ${T.TASKS} SET
         current_target_at = ?,
         target_dates_history = ?::jsonb,
         updated_at = CURRENT_TIMESTAMP
       WHERE task_id = ?`,
      [target_at, JSON.stringify(history), task_id]
    );
    return entry;
  },

  /** Returns expired tasks for notification only — does not change task status (keeps forward/approval flow intact). */
  async expireOverdue() {
    return dbQuery(
      `SELECT task_id FROM ${T.TASKS}
       WHERE task_type = 'assigned'
         AND current_target_at IS NOT NULL
         AND current_target_at <= NOW()
         AND status NOT IN ('completed', 'creator_pending', 'pending_approval')`
    );
  },
};

export default TargetDate;
