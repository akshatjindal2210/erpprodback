import dbQuery from "../shared/db.js";
import { TASK_TABLES as T } from "../../../config/dbTables.js";

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

  async getBySource(source_type, source_id) {
    const rows = await dbQuery(
      `SELECT * FROM ${T.MIS_SCORE_LEDGER} WHERE source_type = ? AND source_id = ? LIMIT 1`,
      [source_type, source_id]
    );
    return rows[0] ?? null;
  },
};

export default MisScore;
