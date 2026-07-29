import dbQuery from "../../../lib/shared/db.js";
import { TASK_TABLES as T } from "../../../../../config/db/dbTables.js";

const MisScore = {
  async addEntry({ user_id, score_delta, source_type, source_id, remark, ledger_date, created_by }) {
    await dbQuery(
      `INSERT INTO ${T.MIS_SCORE_LEDGER}
         (user_id, score_delta, source_type, source_id, remark, ledger_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [user_id, score_delta, source_type, source_id, remark ?? null, ledger_date, created_by ?? null]
    );
  },

  async deleteBySource(source_type, source_id) {
    await dbQuery(
      `DELETE FROM ${T.MIS_SCORE_LEDGER} WHERE source_type = ? AND source_id = ?`,
      [source_type, source_id]
    );
  },

  async getCompiledForUsers(userIds, dateFrom, dateTo) {
    if (!userIds?.length) return 0;
    const placeholders = userIds.map(() => "?").join(",");
    const rows = await dbQuery(
      `SELECT COALESCE(SUM(score_delta), 0)::int AS total
       FROM ${T.MIS_SCORE_LEDGER}
       WHERE user_id IN (${placeholders})
         AND ledger_date >= ?
         AND ledger_date <= ?`,
      [...userIds, dateFrom, dateTo]
    );
    return Number(rows[0]?.total) || 0;
  },

  /** Per-user MIS sum (red tickets etc.) for date range. Returns Map<userId, total>. */
  async getCompiledByUser(userIds, dateFrom, dateTo) {
    const map = new Map();
    if (!userIds?.length) return map;
    const placeholders = userIds.map(() => "?").join(",");
    const rows = await dbQuery(
      `SELECT user_id, COALESCE(SUM(score_delta), 0)::int AS total
       FROM ${T.MIS_SCORE_LEDGER}
       WHERE user_id IN (${placeholders})
         AND ledger_date >= ?
         AND ledger_date <= ?
       GROUP BY user_id`,
      [...userIds, dateFrom, dateTo]
    );
    for (const row of rows || []) {
      map.set(Number(row.user_id), Number(row.total) || 0);
    }
    return map;
  },

  async getBySource(source_type, source_id) {
    const rows = await dbQuery(
      `SELECT * FROM ${T.MIS_SCORE_LEDGER} WHERE source_type = ? AND source_id = ? LIMIT 1`,
      [source_type, source_id]
    );
    return rows[0] ?? null;
  },
};

export default MisScore;
