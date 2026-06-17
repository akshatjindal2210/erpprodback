import dbQuery from "../shared/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { getISTDateString } from "../helpers/clTaskTime.helper.js";

const INSTANCE_TABLE = "task_cl_task_instances";
const MASTER_TABLE   = "task_cl_tasks";

const INSTANCE_SELECT = `
  SELECT i.*,
    d.name  AS department_name,
    des.name AS designation_name,
    p.name  AS person_name,
    v.name  AS verification_user_name
  FROM ${INSTANCE_TABLE} i
  LEFT JOIN ${M.DEPARTMENTS}  d   ON d.id   = i.department_id
  LEFT JOIN ${M.DESIGNATIONS} des ON des.id = i.designation_id
  LEFT JOIN ${M.USERS}        p   ON p.id   = i.person_id
  LEFT JOIN ${M.USERS}        v   ON v.id   = i.verification_user_id
`;

function buildInstanceFilters({ search, department_id, designation_id, person_id, status, verification_user_id, tab, userId, panel, date_from, date_to }) {
  const conditions = ["1=1"];
  const params = [];
  const today = getISTDateString();

  if (search) {
    conditions.push(`(i.title ILIKE ? OR i.description ILIKE ?)`);
    params.push(`%${search}%`, `%${search}%`);
  }
  if (department_id) {
    conditions.push(`i.department_id = ?`);
    params.push(Number(department_id));
  }
  if (designation_id) {
    conditions.push(`i.designation_id = ?`);
    params.push(Number(designation_id));
  }
  if (person_id) {
    conditions.push(`i.person_id = ?`);
    params.push(Number(person_id));
  }
  if (date_from) {
    conditions.push(`i.scheduled_date >= ?`);
    params.push(date_from);
  }
  if (date_to) {
    conditions.push(`i.scheduled_date <= ?`);
    params.push(date_to);
  }
  if (verification_user_id) {
    conditions.push(`i.verification_user_id = ?`);
    params.push(Number(verification_user_id));
  }
  if (userId) {
    conditions.push(`i.person_id = ?`);
    params.push(Number(userId));
  }
  if (status) {
    conditions.push(`i.status = ?`);
    params.push(status);
  }

  if (panel === "due") {
    conditions.push(`i.scheduled_date = ?`);
    params.push(today);
    conditions.push(`i.status = 'pending'`);
  } else if (panel === "open") {
    conditions.push(`(i.status = 'awaiting_verification' OR (i.status = 'pending' AND i.reject_count > 0))`);
  } else if (tab === "today") {
    conditions.push(`i.scheduled_date = ?`);
    params.push(today);
  } else if (tab === "previous") {
    conditions.push(`i.scheduled_date < ?`);
    params.push(today);
  } else if (tab === "future") {
    conditions.push(`i.scheduled_date > ?`);
    params.push(today);
  }

  return { where: conditions.join(" AND "), params };
}

export function advanceOccurrenceDate(dateStr, recurrenceType) {
  const next = new Date(dateStr);
  switch (recurrenceType) {
    case "daily":   next.setDate(next.getDate() + 1); break;
    case "weekly":  next.setDate(next.getDate() + 7); break;
    case "monthly": next.setMonth(next.getMonth() + 1); break;
    case "yearly":  next.setFullYear(next.getFullYear() + 1); break;
    default:        next.setDate(next.getDate() + 1);
  }
  return next.toISOString().split("T")[0];
}

const ClTask = {
  async getInstances(filters) {
    const { page = 1, limit = 10, sortBy, order } = filters;
    const offset = (Number(page) - 1) * Number(limit);
    const finalLimit = Math.min(Number(limit) || 10, 500);

    const validColumns = ["instance_id", "title", "task_type", "wastage", "scheduled_date", "end_date_time", "status", "created_at", "reject_count", "score"];
    const finalSort  = validColumns.includes(sortBy) ? sortBy : "instance_id";
    const finalOrder = order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

    const { where, params } = buildInstanceFilters(filters);

    const query = `
      ${INSTANCE_SELECT}
      WHERE ${where}
      ORDER BY i.${finalSort} ${finalOrder}
      LIMIT ? OFFSET ?
    `;

    return dbQuery(query, [...params, finalLimit, Number(offset)]);
  },

  async countInstances(filters) {
    const { where, params } = buildInstanceFilters(filters);
    const rows = await dbQuery(
      `SELECT COUNT(*) AS total FROM ${INSTANCE_TABLE} i WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.total) || 0;
  },

  async getInstanceById(id) {
    const rows = await dbQuery(`${INSTANCE_SELECT} WHERE i.instance_id = ?`, [id]);
    return rows[0] || null;
  },

  async createMaster(data) {
    const result = await dbQuery(
      `INSERT INTO ${MASTER_TABLE} (
        title, description, sop_description, task_type, recurrence_type,
        recurrence_weekdays, recurrence_month_dates, recurrence_year_dates,
        wastage, verification_user_id, department_id, designation_id, person_id,
        end_date_time, next_occurrence, created_by,
        form_schema, verification_required, scoring_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.title,
        data.description || null,
        data.sop_description || null,
        data.task_type,
        data.recurrence_type || null,
        data.recurrence_weekdays?.length ? JSON.stringify(data.recurrence_weekdays) : null,
        data.recurrence_month_dates?.length ? JSON.stringify(data.recurrence_month_dates) : null,
        data.recurrence_year_dates?.length ? JSON.stringify(data.recurrence_year_dates) : null,
        data.wastage,
        data.verification_user_id || null,
        data.department_id || null,
        data.designation_id || null,
        data.person_id || null,
        data.end_date_time,
        data.next_occurrence || null,
        data.created_by,
        JSON.stringify(data.form_schema || []),
        data.verification_required !== false,
        data.scoring_enabled !== false,
      ],
    );
    return result.insertId;
  },

  async createInstance(data) {
    const result = await dbQuery(
      `INSERT INTO ${INSTANCE_TABLE} (
        cl_task_id, title, description, sop_description, task_type, recurrence_type,
        recurrence_weekdays, recurrence_month_dates, recurrence_year_dates,
        wastage, verification_user_id, department_id, designation_id, person_id,
        end_date_time, scheduled_date, status,
        form_schema, verification_required, scoring_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.cl_task_id,
        data.title,
        data.description || null,
        data.sop_description || null,
        data.task_type,
        data.recurrence_type || null,
        data.recurrence_weekdays?.length ? JSON.stringify(data.recurrence_weekdays) : null,
        data.recurrence_month_dates?.length ? JSON.stringify(data.recurrence_month_dates) : null,
        data.recurrence_year_dates?.length ? JSON.stringify(data.recurrence_year_dates) : null,
        data.wastage,
        data.verification_user_id || null,
        data.department_id || null,
        data.designation_id || null,
        data.person_id || null,
        data.end_date_time,
        data.scheduled_date,
        data.status || "pending",
        JSON.stringify(data.form_schema || []),
        data.verification_required !== false,
        data.scoring_enabled !== false,
      ],
    );
    return result.insertId;
  },

  async submitInstance(id, { personRemark, formResponses, directComplete = false }) {
    if (directComplete) {
      return dbQuery(
        `UPDATE ${INSTANCE_TABLE}
         SET status = 'completed',
             submitted_at = CURRENT_TIMESTAMP,
             completed_at = CURRENT_TIMESTAMP,
             person_remark = ?,
             form_responses = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE instance_id = ?`,
        [personRemark || null, JSON.stringify(formResponses || {}), id],
      );
    }
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE}
       SET status = 'awaiting_verification',
           submitted_at = CURRENT_TIMESTAMP,
           person_remark = ?,
           form_responses = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE instance_id = ?`,
      [personRemark || null, JSON.stringify(formResponses || {}), id],
    );
  },

  async approveInstance(id, score, verifierRemark) {
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE}
       SET status = 'completed',
           score = ?,
           verifier_remark = ?,
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE instance_id = ?`,
      [score, verifierRemark || null, id],
    );
  },

  async rejectInstance(id, verifierRemark) {
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE}
       SET status = 'pending',
           reject_count = reject_count + 1,
           verifier_remark = ?,
           submitted_at = NULL,
           form_responses = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE instance_id = ?`,
      [verifierRemark || null, id],
    );
  },

  async updateInstanceScore(id, score) {
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE} SET score = ?, updated_at = CURRENT_TIMESTAMP WHERE instance_id = ?`,
      [score, id],
    );
  },

  async updateNextOccurrence(clTaskId, nextDate) {
    await dbQuery(
      `UPDATE ${MASTER_TABLE} SET next_occurrence = ?, updated_at = CURRENT_TIMESTAMP WHERE cl_task_id = ?`,
      [nextDate, clTaskId],
    );
  },

  async getFrequentTasksDue(today) {
    return dbQuery(
      `SELECT * FROM ${MASTER_TABLE}
       WHERE task_type = 'frequently'
         AND is_active = TRUE
         AND next_occurrence IS NOT NULL
         AND DATE(next_occurrence) <= ?`,
      [today],
    );
  },

  async deleteInstance(id) {
    return dbQuery(`DELETE FROM ${INSTANCE_TABLE} WHERE instance_id = ?`, [id]);
  },

  async getStats(filters) {
    const total = await this.countInstances(filters);
    const today = getISTDateString();
    const pending = await this.countInstances({ ...filters, status: "pending" });
    const awaiting = await this.countInstances({ ...filters, status: "awaiting_verification" });
    const completed = await this.countInstances({ ...filters, status: "completed" });

    const todayRows = await dbQuery(
      `SELECT COUNT(*) AS total FROM ${INSTANCE_TABLE} i WHERE DATE(i.created_at) = ?`,
      [today],
    );

    return {
      total,
      pending,
      awaiting_verification: awaiting,
      completed,
      today: Number(todayRows[0]?.total) || 0,
    };
  },

  async getMyTabStats(userId) {
    const today = getISTDateString();
    const base = { userId };
    return {
      today: await this.countInstances({ ...base, tab: "today" }),
      previous: await this.countInstances({ ...base, tab: "previous" }),
      future: await this.countInstances({ ...base, tab: "future" }),
      pending: await this.countInstances({ ...base, status: "pending" }),
      awaiting_verification: await this.countInstances({ ...base, status: "awaiting_verification" }),
      completed: await this.countInstances({ ...base, status: "completed" }),
      due_today: await this.countInstances({ ...base, panel: "due" }),
      open: await this.countInstances({ ...base, panel: "open" }),
    };
  },
};

export default ClTask;
