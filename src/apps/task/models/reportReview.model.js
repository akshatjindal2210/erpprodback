import dbQuery from "../shared/db.js";
import { TASK_TABLES as T } from "../../../config/dbTables.js";

const ReportReview = {
  async getByInstance(instanceId) {
    const rows = await dbQuery(
      `SELECT r.*, u.name AS reviewed_by_name
       FROM ${T.REPORT_REVIEWS} r
       LEFT JOIN mst_users u ON u.id = r.reviewed_by
       WHERE r.cl_instance_id = ?
       ORDER BY r.updated_at DESC
       LIMIT 1`,
      [instanceId]
    );
    return rows[0] ?? null;
  },

  async getByInstances(instanceIds) {
    if (!instanceIds?.length) return [];
    const placeholders = instanceIds.map(() => "?").join(",");
    return dbQuery(
      `SELECT r.*, u.name AS reviewed_by_name
       FROM ${T.REPORT_REVIEWS} r
       LEFT JOIN mst_users u ON u.id = r.reviewed_by
       WHERE r.cl_instance_id IN (${placeholders})`,
      instanceIds
    );
  },

  async upsert({ cl_instance_id, task_id, report_date, score, management_remark, is_red_flag, reviewed_by }) {
    const existing = cl_instance_id
      ? (await dbQuery(`SELECT review_id FROM ${T.REPORT_REVIEWS} WHERE cl_instance_id = ? LIMIT 1`, [cl_instance_id]))[0]
      : (await dbQuery(`SELECT review_id FROM ${T.REPORT_REVIEWS} WHERE task_id = ? AND report_date = ? LIMIT 1`, [task_id, report_date]))[0];

    if (existing?.review_id) {
      await dbQuery(
        `UPDATE ${T.REPORT_REVIEWS}
         SET score = ?, management_remark = ?, is_red_flag = ?, reviewed_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE review_id = ?`,
        [score ?? null, management_remark ?? null, !!is_red_flag, reviewed_by, existing.review_id]
      );
      return existing.review_id;
    }

    const rows = await dbQuery(
      `INSERT INTO ${T.REPORT_REVIEWS}
         (cl_instance_id, task_id, report_date, score, management_remark, is_red_flag, reviewed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING review_id`,
      [cl_instance_id ?? null, task_id ?? null, report_date, score ?? null, management_remark ?? null, !!is_red_flag, reviewed_by]
    );
    return rows[0]?.review_id;
  },
};

export default ReportReview;
