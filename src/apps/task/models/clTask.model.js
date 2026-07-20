import dbQuery from "../shared/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { getISTDateString, getISTTimeHM } from "../helpers/clTaskTime.helper.js";

/** Fill deadline calendar day (scheduled + day_offset). */
const FILL_DEADLINE_SQL = `(i.scheduled_date + COALESCE(i.day_offset, m.day_offset, 0) * INTERVAL '1 day')::date`;

/**
 * Fill-before HH:MM (instance → master → 11:00).
 * 00:00 (12:00 AM) treated as 23:59 so the window is not empty all day.
 */
const DUE_TIME_HM_SQL = `(
  CASE
    WHEN SUBSTRING(COALESCE(NULLIF(TRIM(i.due_time::text), ''), NULLIF(TRIM(m.due_time::text), ''), '11:00') FROM 1 FOR 5) = '00:00'
    THEN '23:59'
    ELSE SUBSTRING(COALESCE(NULLIF(TRIM(i.due_time::text), ''), NULLIF(TRIM(m.due_time::text), ''), '11:00') FROM 1 FOR 5)
  END
)`;

const INSTANCE_TABLE = "task_cl_tasks";
const MASTER_TABLE   = "task_cl_tasks_master";

const INSTANCE_SELECT = `
  SELECT i.*,
    COALESCE(i.day_offset, m.day_offset, 0) AS day_offset,
    m.created_by AS master_created_by,
    COALESCE(NULLIF(TRIM(m.created_by_name), ''), cb.name) AS master_created_by_name,
    CASE
      WHEN i.form_schema IS NULL
        OR i.form_schema::text IN ('null', '[]', '{}', '')
      THEN m.form_schema
      ELSE i.form_schema
    END AS form_schema,
    CASE
      WHEN i.attachment IS NULL
        OR i.attachment::text IN ('null', '[]', '{}', '')
      THEN m.attachment
      ELSE i.attachment
    END AS attachment,
    COALESCE(NULLIF(TRIM(i.sop_description), ''), m.sop_description) AS sop_description,
    COALESCE(i.sop_required, m.sop_required, FALSE) AS sop_required,
    d.name  AS department_name,
    des.name AS designation_name,
    p.name  AS person_name,
    v.name  AS verification_user_name
  FROM ${INSTANCE_TABLE} i
  LEFT JOIN ${MASTER_TABLE}   m   ON m.cl_task_id = i.cl_task_id
  LEFT JOIN ${M.USERS}        cb  ON cb.id  = m.created_by
  LEFT JOIN ${M.DEPARTMENTS}  d   ON d.id   = i.department_id
  LEFT JOIN ${M.DESIGNATIONS} des ON des.id = i.designation_id
  LEFT JOIN ${M.USERS}        p   ON p.id   = i.person_id
  LEFT JOIN ${M.USERS}        v   ON v.id   = i.verification_user_id
`;

const MASTER_SELECT = `
  SELECT m.*,
    d.name  AS department_name,
    des.name AS designation_name,
    p.name  AS person_name,
    v.name  AS verification_user_name,
    COALESCE(NULLIF(TRIM(m.created_by_name), ''), cb.name) AS created_by_name,
    COALESCE(NULLIF(TRIM(m.updated_by_name), ''), ub.name) AS updated_by_name,
    m.approved_by AS approved_by_name,
    (
      SELECT COUNT(*)::int FROM ${INSTANCE_TABLE} i
      WHERE i.cl_task_id = m.cl_task_id
    ) AS instance_count
  FROM ${MASTER_TABLE} m
  LEFT JOIN ${M.DEPARTMENTS}  d   ON d.id   = m.department_id
  LEFT JOIN ${M.DESIGNATIONS} des ON des.id = m.designation_id
  LEFT JOIN ${M.USERS}        p   ON p.id   = m.person_id
  LEFT JOIN ${M.USERS}        v   ON v.id   = m.verification_user_id
  LEFT JOIN ${M.USERS}        cb  ON cb.id  = m.created_by
  LEFT JOIN ${M.USERS}        ub  ON ub.id  = m.updated_by
`;

function buildMasterFilters({ search, department_id, designation_id, person_id, task_type, is_active, approved, view_days }) {
  const conditions = ["1=1"];
  const params = [];

  if (search) {
    conditions.push(`(m.title ILIKE ? OR m.description ILIKE ?)`);
    params.push(`%${search}%`, `%${search}%`);
  }
  if (Number(view_days) > 0) {
    conditions.push(`m.created_at::date >= CURRENT_DATE - (?::int - 1)`);
    params.push(Number(view_days));
  }
  if (department_id) {
    conditions.push(`m.department_id = ?`);
    params.push(Number(department_id));
  }
  if (designation_id) {
    conditions.push(`m.designation_id = ?`);
    params.push(Number(designation_id));
  }
  if (person_id) {
    conditions.push(`m.person_id = ?`);
    params.push(Number(person_id));
  }
  if (task_type && task_type !== "all") {
    conditions.push(`m.task_type = ?`);
    params.push(task_type);
  }
  const approvedFilter = typeof approved === "boolean" ? approved : is_active;
  if (typeof approvedFilter === "boolean") {
    conditions.push(`m.approved = ?`);
    params.push(approvedFilter);
  }

  return { where: conditions.join(" AND "), params };
}

function buildInstanceFilters({
  search,
  department_id,
  designation_id,
  person_id,
  cl_task_id,
  status,
  status_in,
  verification_user_id,
  tab,
  userId,
  panel,
  date_from,
  date_to,
  date_field,
  task_type,
  recurrence_type,
  history_scope,
  viewer_id,
  viewer_is_creator,
  view_days,
}) {
  const conditions = ["1=1"];
  const params = [];
  const today = getISTDateString();
  const nowHm = getISTTimeHM();

  if (search) {
    conditions.push(`(i.title ILIKE ? OR i.description ILIKE ? OR p.name ILIKE ?)`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (Number(view_days) > 0) {
    /** Prefer submission / schedule so active due queues aren't hidden by old create date. */
    conditions.push(
      `COALESCE(i.submitted_at::date, i.scheduled_date, i.created_at::date) >= CURRENT_DATE - (?::int - 1)`,
    );
    params.push(Number(view_days));
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
  if (cl_task_id) {
    conditions.push(`i.cl_task_id = ?`);
    params.push(Number(cl_task_id));
  }
  if (date_from) {
    const col = date_field === "submitted_at" ? "i.submitted_at" : "i.scheduled_date";
    conditions.push(`${col}::date >= ?`);
    params.push(date_from);
  }
  if (date_to) {
    const col = date_field === "submitted_at" ? "i.submitted_at" : "i.scheduled_date";
    conditions.push(`${col}::date <= ?`);
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
  } else if (Array.isArray(status_in) && status_in.length) {
    conditions.push(`i.status IN (${status_in.map(() => "?").join(",")})`);
    params.push(...status_in);
  }
  if (task_type) {
    conditions.push(`i.task_type = ?`);
    params.push(task_type);
  }
  if (recurrence_type) {
    conditions.push(`i.recurrence_type = ?`);
    params.push(recurrence_type);
  }

  // Shared history: assignee OR verifier OR master creator (when viewer_is_creator)
  if (history_scope === "shared" && viewer_id) {
    if (viewer_is_creator) {
      conditions.push(`(
        i.person_id = ?
        OR i.verification_user_id = ?
        OR m.created_by = ?
      )`);
      params.push(Number(viewer_id), Number(viewer_id), Number(viewer_id));
    } else {
      conditions.push(`(i.person_id = ? OR i.verification_user_id = ?)`);
      params.push(Number(viewer_id), Number(viewer_id));
    }
  }

  if (panel === "missed" || tab === "missed") {
    // Frequently pending whose fill window closed (past deadline day, or deadline day after due_time IST).
    conditions.push(`i.status = 'pending'`);
    conditions.push(`i.task_type = 'frequently'`);
    conditions.push(`i.scheduled_date <= ?`);
    conditions.push(`(
      ${FILL_DEADLINE_SQL} < ?
      OR (${FILL_DEADLINE_SQL} = ? AND ${DUE_TIME_HM_SQL} <= ?)
    )`);
    params.push(today, today, today, nowHm);
  } else if (panel === "due_frequently" || tab === "due_frequently") {
    // CL Verification Due: frequently only (exclude open), still inside fill window
    conditions.push(`i.status = 'pending'`);
    conditions.push(`i.task_type = 'frequently'`);
    conditions.push(`i.scheduled_date <= ?`);
    conditions.push(`(
      ${FILL_DEADLINE_SQL} > ?
      OR (${FILL_DEADLINE_SQL} = ? AND ${DUE_TIME_HM_SQL} > ?)
    )`);
    params.push(today, today, today, nowHm);
  } else if (panel === "due" || tab === "due" || tab === "today") {
    // Due instances:
    // - frequently: pending inside fill window
    // - open: only rejected fills (reject_count > 0) — open new fills come from Task Master
    conditions.push(`i.status = 'pending'`);
    conditions.push(`(
      (
        i.task_type = 'frequently'
        AND i.scheduled_date <= ?
        AND (
          ${FILL_DEADLINE_SQL} > ?
          OR (${FILL_DEADLINE_SQL} = ? AND ${DUE_TIME_HM_SQL} > ?)
        )
      )
      OR (
        i.task_type = 'open'
        AND COALESCE(i.reject_count, 0) > 0
      )
    )`);
    params.push(today, today, today, nowHm);
  } else if (panel === "open_type" || tab === "open") {
    // Open Due is masters — instance list empty for this tab (merged in controller)
    conditions.push(`i.task_type = 'open'`);
    conditions.push(`i.status = 'pending'`);
    conditions.push(`COALESCE(i.reject_count, 0) > 0`);
  } else if (panel === "frequently" || tab === "frequently") {
    conditions.push(`i.task_type = 'frequently'`);
    conditions.push(`i.status = 'pending'`);
  } else if (panel === "submitted" || tab === "submitted" || tab === "history") {
    // Only when caller did not already pin status / status_in
    if (!status && !(Array.isArray(status_in) && status_in.length)) {
      // Open: same instance stays pending after fills — still show in history if fills archived
      conditions.push(`(
        i.status IN ('awaiting_verification', 'completed')
        OR (
          i.task_type = 'open'
          AND i.form_responses IS NOT NULL
          AND jsonb_typeof(i.form_responses->'fills') = 'array'
          AND jsonb_array_length(i.form_responses->'fills') > 0
        )
      )`);
    }
  } else if (tab === "previous") {
    conditions.push(`i.scheduled_date < ?`);
    params.push(today);
  } else if (tab === "future") {
    conditions.push(`i.scheduled_date > ?`);
    params.push(today);
    conditions.push(`i.status = 'pending'`);
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
  async getMasters(filters) {
    const { page = 1, limit = 10, sortBy, order } = filters;
    const offset = (Number(page) - 1) * Number(limit);
    const finalLimit = Math.min(Number(limit) || 10, 5000);

    const validColumns = [
      "cl_task_id", "title", "task_type", "weightage", "due_time",
      "next_occurrence", "approved", "created_at", "recurrence_type",
    ];
    const finalSort = validColumns.includes(sortBy) ? sortBy : "cl_task_id";
    const finalOrder = order?.toUpperCase() === "DESC" ? "DESC" : "ASC";
    const { where, params } = buildMasterFilters(filters);

    return dbQuery(
      `${MASTER_SELECT}
       WHERE ${where}
       ORDER BY m.${finalSort} ${finalOrder}
       LIMIT ? OFFSET ?`,
      [...params, finalLimit, Number(offset)],
    );
  },

  async countMasters(filters) {
    const { where, params } = buildMasterFilters(filters);
    const rows = await dbQuery(
      `SELECT COUNT(*) AS total FROM ${MASTER_TABLE} m WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.total) || 0;
  },

  async getMasterById(id) {
    const rows = await dbQuery(`${MASTER_SELECT} WHERE m.cl_task_id = ?`, [id]);
    return rows[0] || null;
  },

  async setMasterActive(id, isActive, actor = null) {
    if (isActive && actor) {
      return dbQuery(
        `UPDATE ${MASTER_TABLE}
         SET approved = TRUE,
             approved_by = ?,
             approved_at = CURRENT_TIMESTAMP,
             updated_by = ?,
             updated_by_name = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE cl_task_id = ?`,
        [actor.name ?? null, actor.id ?? null, actor.name ?? null, id],
      );
    }
    if (!isActive && actor) {
      return dbQuery(
        `UPDATE ${MASTER_TABLE}
         SET approved = FALSE,
             updated_by = ?,
             updated_by_name = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE cl_task_id = ?`,
        [actor.id ?? null, actor.name ?? null, id],
      );
    }
    return dbQuery(
      `UPDATE ${MASTER_TABLE}
       SET approved = ?, updated_at = CURRENT_TIMESTAMP
       WHERE cl_task_id = ?`,
      [!!isActive, id],
    );
  },

  async deleteMaster(id) {
    return dbQuery(`DELETE FROM ${MASTER_TABLE} WHERE cl_task_id = ?`, [id]);
  },

  async getMasterStats(filters) {
    const total = await this.countMasters(filters);
    const active = await this.countMasters({ ...filters, approved: true });
    const inactive = await this.countMasters({ ...filters, approved: false });
    const open = await this.countMasters({ ...filters, task_type: "open" });
    const frequently = await this.countMasters({ ...filters, task_type: "frequently" });
    return { total, active, inactive, open, frequently };
  },

  async getInstances(filters) {
    const { page = 1, limit = 10, sortBy, order } = filters;
    const offset = (Number(page) - 1) * Number(limit);
    const finalLimit = Math.min(Number(limit) || 10, 5000);

    const validColumns = [
      "instance_id", "title", "task_type", "weightage", "scheduled_date",
      "status", "created_at", "reject_count", "score", "submitted_at",
    ];
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
      `SELECT COUNT(*) AS total
       FROM ${INSTANCE_TABLE} i
       LEFT JOIN ${MASTER_TABLE} m ON m.cl_task_id = i.cl_task_id
       LEFT JOIN ${M.USERS} p ON p.id = i.person_id
       WHERE ${where}`,
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
        weightage, verification_user_id, department_id, designation_id, person_id,
        due_time, day_offset, next_occurrence, approved,
        created_by, created_by_name, approved_by, approved_at,
        form_schema, verification_required, scoring_enabled, sop_required, attachment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.title,
        data.description || null,
        data.sop_description || null,
        data.task_type,
        data.recurrence_type || null,
        data.recurrence_weekdays?.length ? JSON.stringify(data.recurrence_weekdays) : null,
        data.recurrence_month_dates?.length ? JSON.stringify(data.recurrence_month_dates) : null,
        data.recurrence_year_dates?.length ? JSON.stringify(data.recurrence_year_dates) : null,
        data.weightage,
        data.verification_user_id || null,
        data.department_id || null,
        data.designation_id || null,
        data.person_id || null,
        data.due_time != null && data.due_time !== "" ? data.due_time : null,
        Number.isFinite(Number(data.day_offset)) ? Math.max(0, Math.min(14, Math.floor(Number(data.day_offset)))) : 0,
        data.next_occurrence || null,
        data.approved !== false && data.is_active !== false,
        data.created_by,
        data.created_by_name || null,
        data.approved !== false && data.is_active !== false
          ? (data.approved_by ?? data.activated_by_name ?? data.created_by_name ?? null)
          : null,
        data.approved !== false && data.is_active !== false
          ? (data.approved_at || data.activated_at || new Date())
          : null,
        JSON.stringify(data.form_schema || []),
        data.verification_required !== false,
        data.scoring_enabled !== false,
        data.sop_required === true,
        data.attachment == null
          ? null
          : (typeof data.attachment === "string" ? data.attachment : JSON.stringify(data.attachment)),
      ],
    );
    return result.insertId;
  },

  /**
   * Update master only — does not mutate completed / awaiting instances.
   * Pending instances are synced separately via syncPendingInstancesFromMaster.
   */
  async updateMaster(id, data) {
    return dbQuery(
      `UPDATE ${MASTER_TABLE} SET
        title = ?,
        description = ?,
        sop_description = ?,
        task_type = ?,
        recurrence_type = ?,
        recurrence_weekdays = ?,
        recurrence_month_dates = ?,
        recurrence_year_dates = ?,
        weightage = ?,
        verification_user_id = ?,
        department_id = ?,
        designation_id = ?,
        person_id = ?,
        due_time = ?,
        day_offset = ?,
        form_schema = ?,
        verification_required = ?,
        scoring_enabled = ?,
        sop_required = ?,
        attachment = ?,
        updated_by = ?,
        updated_by_name = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE cl_task_id = ?`,
      [
        data.title,
        data.description || null,
        data.sop_description || null,
        data.task_type,
        data.recurrence_type || null,
        data.recurrence_weekdays?.length ? JSON.stringify(data.recurrence_weekdays) : null,
        data.recurrence_month_dates?.length ? JSON.stringify(data.recurrence_month_dates) : null,
        data.recurrence_year_dates?.length ? JSON.stringify(data.recurrence_year_dates) : null,
        data.weightage,
        data.verification_user_id || null,
        data.department_id || null,
        data.designation_id || null,
        data.person_id || null,
        data.due_time != null && data.due_time !== "" ? data.due_time : null,
        Number.isFinite(Number(data.day_offset)) ? Math.max(0, Math.min(14, Math.floor(Number(data.day_offset)))) : 0,
        JSON.stringify(data.form_schema || []),
        data.verification_required !== false,
        data.scoring_enabled !== false,
        data.sop_required === true,
        data.attachment == null
          ? null
          : (typeof data.attachment === "string" ? data.attachment : JSON.stringify(data.attachment)),
        data.updated_by ?? null,
        data.updated_by_name ?? null,
        id,
      ],
    );
  },

  /**
   * Push master template snapshot onto all still-pending instances
   * so form fields / SOP / attachments appear for assignees immediately after edit.
   * Completed & awaiting_verification stay frozen.
   */
  async syncPendingInstancesFromMaster(masterId, data) {
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE} SET
        title = ?,
        description = ?,
        sop_description = ?,
        task_type = ?,
        recurrence_type = ?,
        recurrence_weekdays = ?,
        recurrence_month_dates = ?,
        recurrence_year_dates = ?,
        weightage = ?,
        verification_user_id = ?,
        department_id = ?,
        designation_id = ?,
        person_id = ?,
        due_time = ?,
        day_offset = ?,
        form_schema = ?,
        verification_required = ?,
        scoring_enabled = ?,
        sop_required = ?,
        attachment = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE cl_task_id = ?
         AND status = 'pending'`,
      [
        data.title,
        data.description || null,
        data.sop_description || null,
        data.task_type,
        data.recurrence_type || null,
        data.recurrence_weekdays?.length ? JSON.stringify(data.recurrence_weekdays) : null,
        data.recurrence_month_dates?.length ? JSON.stringify(data.recurrence_month_dates) : null,
        data.recurrence_year_dates?.length ? JSON.stringify(data.recurrence_year_dates) : null,
        data.weightage,
        data.verification_user_id || null,
        data.department_id || null,
        data.designation_id || null,
        data.person_id || null,
        data.due_time != null && data.due_time !== "" ? data.due_time : null,
        data.task_type === "frequently"
          ? (Number.isFinite(Number(data.day_offset)) ? Math.max(0, Math.min(14, Math.floor(Number(data.day_offset)))) : 0)
          : 0,
        JSON.stringify(data.form_schema || []),
        data.verification_required !== false,
        data.scoring_enabled !== false,
        data.sop_required === true,
        data.attachment == null
          ? null
          : (typeof data.attachment === "string" ? data.attachment : JSON.stringify(data.attachment)),
        masterId,
      ],
    );
  },

  async createInstance(data) {
    const result = await dbQuery(
      `INSERT INTO ${INSTANCE_TABLE} (
        cl_task_id, title, description, sop_description, task_type, recurrence_type,
        recurrence_weekdays, recurrence_month_dates, recurrence_year_dates,
        weightage, verification_user_id, department_id, designation_id, person_id,
        due_time, day_offset, scheduled_date, status,
        form_schema, verification_required, scoring_enabled, sop_required, attachment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.weightage,
        data.verification_user_id || null,
        data.department_id || null,
        data.designation_id || null,
        data.person_id || null,
        data.due_time != null && data.due_time !== "" ? data.due_time : null,
        Number.isFinite(Number(data.day_offset)) ? Math.max(0, Math.min(14, Math.floor(Number(data.day_offset)))) : 0,
        data.scheduled_date,
        data.status || "pending",
        JSON.stringify(data.form_schema || []),
        data.verification_required !== false,
        data.scoring_enabled !== false,
        data.sop_required === true,
        (() => {
          if (data.attachment == null) return null;
          if (Array.isArray(data.attachment) && data.attachment.length === 0) return null;
          return typeof data.attachment === "string"
            ? data.attachment
            : JSON.stringify(data.attachment);
        })(),
      ],
    );
    return result.insertId;
  },

  async submitInstance(id, { personRemark, formResponses, directComplete = false, sopAcknowledged = false }) {
    const responsesJson =
      typeof formResponses === "string"
        ? formResponses
        : JSON.stringify(formResponses || {});

    if (directComplete) {
      return dbQuery(
        `UPDATE ${INSTANCE_TABLE}
         SET status = 'completed',
             submitted_at = CURRENT_TIMESTAMP,
             completed_at = CURRENT_TIMESTAMP,
             person_remark = ?,
             form_responses = ?::jsonb,
             sop_acknowledged = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE instance_id = ?`,
        [personRemark || null, responsesJson, !!sopAcknowledged, id],
      );
    }
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE}
       SET status = 'awaiting_verification',
           submitted_at = CURRENT_TIMESTAMP,
           person_remark = ?,
           form_responses = ?::jsonb,
           sop_acknowledged = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE instance_id = ?`,
      [personRemark || null, responsesJson, !!sopAcknowledged, id],
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

  /**
   * Open task: archive this fill into form_responses.fills[], then reopen same
   * instance as pending so user can fill again — no new DB row.
   */
  async approveOpenAndReopen(id, {
    formResponses,
    score,
    verifierRemark,
    rejectCount = 0,
  }) {
    const responsesJson =
      typeof formResponses === "string"
        ? formResponses
        : JSON.stringify(formResponses || { entries: [], fills: [] });
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE}
       SET status = 'pending',
           score = NULL,
           reject_count = 0,
           verifier_remark = NULL,
           person_remark = NULL,
           submitted_at = NULL,
           completed_at = NULL,
           sop_acknowledged = FALSE,
           form_responses = ?::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE instance_id = ?`,
      [responsesJson, id],
    );
  },

  /**
   * Open task without verification: archive fill + reopen pending in one step.
   */
  async completeOpenAndReopen(id, {
    formResponses,
    personRemark,
    sopAcknowledged = false,
  }) {
    const responsesJson =
      typeof formResponses === "string"
        ? formResponses
        : JSON.stringify(formResponses || { entries: [], fills: [] });
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE}
       SET status = 'pending',
           score = NULL,
           reject_count = 0,
           verifier_remark = NULL,
           person_remark = NULL,
           submitted_at = NULL,
           completed_at = NULL,
           sop_acknowledged = FALSE,
           form_responses = ?::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE instance_id = ?`,
      [responsesJson, id],
    );
  },

  /** Save open form_responses while keeping instance pending (fill-level verify). */
  async saveOpenFormResponses(id, {
    formResponses,
    personRemark,
    verifierRemark,
    rejectCount,
    clearCycle = false,
  }) {
    const responsesJson =
      typeof formResponses === "string"
        ? formResponses
        : JSON.stringify(formResponses || { entries: [], fills: [] });

    if (clearCycle) {
      return dbQuery(
        `UPDATE ${INSTANCE_TABLE}
         SET status = 'pending',
             form_responses = ?::jsonb,
             person_remark = ?,
             verifier_remark = ?,
             reject_count = ?,
             submitted_at = NULL,
             completed_at = NULL,
             score = NULL,
             sop_acknowledged = FALSE,
             updated_at = CURRENT_TIMESTAMP
         WHERE instance_id = ?`,
        [
          responsesJson,
          personRemark ?? null,
          verifierRemark ?? null,
          Math.max(0, Number(rejectCount) || 0),
          id,
        ],
      );
    }

    const sets = ["form_responses = ?::jsonb", "status = 'pending'", "updated_at = CURRENT_TIMESTAMP"];
    const params = [responsesJson];
    if (personRemark !== undefined) {
      sets.push("person_remark = ?");
      params.push(personRemark);
    }
    if (verifierRemark !== undefined) {
      sets.push("verifier_remark = ?");
      params.push(verifierRemark);
    }
    if (rejectCount !== undefined) {
      sets.push("reject_count = ?");
      params.push(Math.max(0, Number(rejectCount) || 0));
    }
    params.push(id);
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE} SET ${sets.join(", ")} WHERE instance_id = ?`,
      params,
    );
  },

  async rejectInstance(id, verifierRemark) {
    // Keep form_responses so assignee/verifier/creator can correct via shared edit.
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE}
       SET status = 'pending',
           reject_count = reject_count + 1,
           verifier_remark = ?,
           submitted_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE instance_id = ?`,
      [verifierRemark || null, id],
    );
  },

  async updateSubmission(id, {
    formResponses,
    personRemark,
    verifierRemark,
    editNote,
    actor,
    keepAwaiting = true,
  }) {
    const responsesJson =
      typeof formResponses === "string"
        ? formResponses
        : JSON.stringify(formResponses || {});
    const statusSql = keepAwaiting
      ? `status = 'awaiting_verification', submitted_at = COALESCE(submitted_at, CURRENT_TIMESTAMP),`
      : "";
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE}
       SET ${statusSql}
           form_responses = ?::jsonb,
           person_remark = COALESCE(?, person_remark),
           verifier_remark = COALESCE(?, verifier_remark),
           edit_note = ?,
           last_edited_by = ?,
           last_edited_by_name = ?,
           last_edited_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE instance_id = ?`,
      [
        responsesJson,
        personRemark ?? null,
        verifierRemark ?? null,
        editNote || null,
        actor?.id ?? null,
        actor?.name ?? null,
        id,
      ],
    );
  },

  /** True if assignee already has any instance for this master on that day (blocks duplicate clones). */
  async hasPendingInstanceForDay(clTaskId, personId, scheduledDate) {
    const rows = await dbQuery(
      `SELECT instance_id FROM ${INSTANCE_TABLE}
       WHERE cl_task_id = ?
         AND person_id = ?
         AND scheduled_date = ?
       LIMIT 1`,
      [clTaskId, personId, scheduledDate],
    );
    return !!rows[0];
  },

  async updateInstanceScore(id, score) {
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE} SET score = ?, updated_at = CURRENT_TIMESTAMP WHERE instance_id = ?`,
      [score, id],
    );
  },

  /** Update verifier score / remark without changing status. */
  async updateVerifierReview(id, { score, verifierRemark } = {}) {
    const sets = ["updated_at = CURRENT_TIMESTAMP"];
    const params = [];
    if (score !== undefined) {
      sets.push("score = ?");
      params.push(score);
    }
    if (verifierRemark !== undefined) {
      sets.push("verifier_remark = ?");
      params.push(verifierRemark || null);
    }
    if (params.length === 0) return { affectedRows: 0 };
    params.push(id);
    return dbQuery(
      `UPDATE ${INSTANCE_TABLE} SET ${sets.join(", ")} WHERE instance_id = ?`,
      params,
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
         AND approved = TRUE
         AND next_occurrence IS NOT NULL
         AND DATE(next_occurrence) <= ?`,
      [today],
    );
  },

  /**
   * Masters whose next_occurrence already jumped past today — may still need
   * today's clone (e.g. 00:00 due_time skipped create earlier).
   */
  async getFrequentTasksForTodayRecovery(today) {
    return dbQuery(
      `SELECT * FROM ${MASTER_TABLE}
       WHERE task_type = 'frequently'
         AND approved = TRUE
         AND next_occurrence IS NOT NULL
         AND DATE(next_occurrence) > ?`,
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
    const base = { userId };
    return {
      due: await this.countInstances({ ...base, tab: "due" }),
      open: await this.countInstances({ ...base, tab: "open" }),
      frequently: await this.countInstances({ ...base, tab: "frequently" }),
      history: await this.countInstances({ ...base, tab: "history" }),
      today: await this.countInstances({ ...base, tab: "due" }),
      previous: await this.countInstances({ ...base, tab: "previous" }),
      future: await this.countInstances({ ...base, tab: "future" }),
      pending: await this.countInstances({ ...base, status: "pending" }),
      awaiting_verification: await this.countInstances({ ...base, status: "awaiting_verification" }),
      submitted: await this.countInstances({ ...base, status: "awaiting_verification" }),
      completed: await this.countInstances({ ...base, status: "completed" }),
      due_today: await this.countInstances({ ...base, tab: "due" }),
    };
  },
};

export default ClTask;
