import dbQuery from "../shared/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

async function roleFilter(userRole, userId, report = false) {
  
  let isManager = false;
  let department_id = null;

  if (userRole === "user" || userRole === "executive_assistant") {
    const res = await dbQuery(
      `SELECT d.name AS designation, department_id FROM ${M.USERS} u LEFT JOIN ${M.DESIGNATIONS} d ON u.designation_id = d.id WHERE u.id = ?`,
      [userId]
    );
    if (res?.[0]) {
      if (userRole === "user") {
        isManager = res[0].designation?.toLowerCase() === "manager";
        department_id = res[0].department_id;
      }
    }
  }

  if (report) {
    // executive_assistant role cross-department access
    if (userRole === "executive_assistant") {
      return { clause: null, values: [] };
    }

    // Admin / super_admin
    if (userRole === "admin" || userRole === "super_admin") {
      return { clause: null, values: [] };
    }

    if (isManager && department_id) {
      return {
        clause: `EXISTS (
          SELECT 1 FROM ${M.USERS} u
          WHERE u.department_id = ?
            AND u.id IN (t.first_assigned_to, t.current_holder_id, t.assigned_by, t.created_by)
        )`,
        values: [department_id]
      };
    }

    // Normal user with department
    if (department_id) {
      return {
        clause: `EXISTS (
          SELECT 1 FROM ${M.USERS} u
          WHERE u.id IN (t.created_by, t.first_assigned_to, t.current_holder_id, t.assigned_by)
          AND u.department_id = ?
        )`,
        values: [department_id]
      };
    }
  }

  return {
    clause: `(
      t.created_by = ? OR t.first_assigned_to = ? OR t.current_holder_id = ? OR t.assigned_by = ? OR
      EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.task_id AND ta.assigned_to = ?)
    )`,
    values: [userId, userId, userId, userId, userId]
  };
}

/** Tasks visible under "Assigned To Me" L1, current holder, or active assignee (incl. forward) */
function assignedToViewClause(userId) {
  return {
    sql: `(
      t.first_assigned_to = ?
      OR t.current_holder_id = ?
      OR EXISTS (
        SELECT 1 FROM task_assignments ta
        WHERE ta.task_id = t.task_id AND ta.assigned_to = ? AND ta.is_active = TRUE
      )
    )`,
    params: [userId, userId, userId],
  };
}

const Task = {

  // GET ALL   paginated list
  async getAll({
    page = 1, limit = 10, search = "", sortBy = "t.task_id", order = "DESC", status, priority, category_id, view, userId, userRole, task_type, reminder, overdue, 
    upcoming_due, new_today, creator_pending, action_required_today, include_closed, department_id, user_id, assigned_by_id, report = false
  }) {
    const offset = (Number(page) - 1) * Number(limit);
    const where  = ["1=1"];
    const params = [];

    const validSort = ["t.task_id","t.title","t.priority","t.status","t.due_date","t.created_at"];
    const safeSort  = validSort.includes(sortBy) ? sortBy : "t.task_id";
    const safeOrder = order.toUpperCase() === "ASC" ? "ASC" : "DESC";

    //  Search
    if (search) {
      where.push("(t.title LIKE ? OR t.description LIKE ? OR cat.name LIKE ? OR holder.name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    //  Filters
    if (status)      { where.push("t.status = ?");      params.push(status); }
    if (priority)    { where.push("t.priority = ?");    params.push(priority); }
    if (category_id) { where.push("t.category_id = ?"); params.push(category_id); }
    
    // Assigned By Filter
    if (assigned_by_id) { 
      where.push("t.assigned_by = ?"); 
      params.push(assigned_by_id); 
    }

    // Assigned To (User) Filter L1, current holder, or active assignee
    if (user_id) {
      const { sql, params: viewParams } = assignedToViewClause(user_id);
      where.push(sql);
      params.push(...viewParams);
    }

    // Department Filter
    if (department_id) {
      where.push(`EXISTS (
        SELECT 1 FROM ${M.USERS} u 
        WHERE u.department_id = ? 
        AND u.id IN (t.first_assigned_to, t.current_holder_id, t.assigned_by, t.created_by)
      )`);
      params.push(department_id);
    }

    if (task_type) {
      const types = Array.isArray(task_type) ? task_type : [task_type];
      where.push(`t.task_type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }

    //  View (Legacy logic, kept for compatibility but refined)
    if (!report) {
      if (view === "created")     { where.push("t.created_by = ?");        params.push(userId); }
      if (view === "assigned_to") {
        const { sql, params: viewParams } = assignedToViewClause(userId);
        where.push(sql);
        params.push(...viewParams);
      }
      if (view === "assigned_by") { where.push("t.assigned_by = ?");       params.push(userId); }
      if (view === "holding")     { where.push("t.current_holder_id = ?"); params.push(userId); }
    }
    if (!include_closed) { where.push("t.status != 'closed'"); }

    //  Reminder / Overdue / Today / Creator Pending
    if (reminder)      { where.push("tsn.reminder_at >= CURRENT_DATE"); }
    if (overdue)       { where.push("t.due_date < CURRENT_DATE AND t.status NOT IN ('completed','closed')"); }
    if (upcoming_due) { where.push(`DATE(t.due_date) BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '1 day') AND t.status NOT IN ('completed','closed')`); }
    if (new_today)     { where.push("DATE(t.created_at) = CURRENT_DATE"); }
    if (creator_pending) { where.push("t.status = 'creator_pending'"); }
    if (action_required_today) {
      where.push(`(
        (t.due_date < CURRENT_DATE AND t.status NOT IN ('completed','closed'))
        OR (t.status = 'creator_pending')
        OR (DATE(t.due_date) = CURRENT_DATE)
        OR (DATE(COALESCE(tsn.reminder_at, t.reminder_date)) = CURRENT_DATE)
        OR (DATE(t.updated_at) = CURRENT_DATE)
        OR (DATE(t.created_at) = CURRENT_DATE)
      )`);
    }

    //  Security Access Clause (ONLY for access control)
    const { clause, values } = await roleFilter(userRole, userId, report);
    if (clause) {
      where.push(clause);
      params.push(...values);
    }

    return dbQuery(
      `SELECT DISTINCT
        t.task_id, t.title, t.description, t.priority, t.status,
        t.task_type, t.is_recurring, t.recurrence_type, t.creator_type,

        TO_CHAR(t.due_date, 'YYYY-MM-DD') AS due_date,
        TO_CHAR(t.completed_at, 'YYYY-MM-DD HH24:MI') AS completed_at,
        TO_CHAR(t.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
        TO_CHAR(t.updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at,

        t.created_by AS created_by_id,
        cb.name AS created_by_name,

        t.assigned_by AS assigned_by_id,
        ab.name AS assigned_by_name,

        t.first_assigned_to AS first_assigned_to_id,
        fa.name AS first_assigned_to_name,

        t.current_holder_id,
        holder.name AS current_holder_name,
        t.current_assignment_id,

        cat.id AS category_id,
        cat.name AS category_name,

        ca.assignment_level AS current_assignment_level,
        ca.is_level_one AS current_is_level_one,

        (SELECT COUNT(*) FROM task_log tl WHERE tl.task_id = t.task_id) AS log_count,

        CASE 
          WHEN t.status = 'pending' AND (lc.attachments IS NULL OR COALESCE(jsonb_array_length(lc.attachments::jsonb), 0) = 0)
          THEN NULL
          ELSE lc.message
        END AS last_message,
        
        lc.created_at AS last_message_at,
        TO_CHAR(tsn.reminder_at, 'YYYY-MM-DD HH24:MI') AS reminder_date

      FROM task_tasks t
      LEFT JOIN ${M.USERS} cb ON cb.id = t.created_by
      LEFT JOIN ${M.USERS} ab ON ab.id = t.assigned_by
      LEFT JOIN ${M.USERS} fa ON fa.id = t.first_assigned_to
      LEFT JOIN ${M.USERS} holder ON holder.id = t.current_holder_id
      LEFT JOIN task_assignments ca ON ca.assignment_id = t.current_assignment_id
      LEFT JOIN task_categories cat ON cat.id = t.category_id
      LEFT JOIN task_self_notes tsn ON tsn.task_id = t.task_id AND tsn.user_id = ?
      LEFT JOIN (
        SELECT tc1.task_id, tc1.message, tc1.attachments, tc1.created_at
        FROM task_chat tc1
        INNER JOIN (
          SELECT task_id, MAX(created_at) AS last_msg_at
          FROM task_chat
          GROUP BY task_id
        ) tc2 ON tc1.task_id = tc2.task_id AND tc1.created_at = tc2.last_msg_at
      ) lc ON lc.task_id = t.task_id

      WHERE ${where.join(" AND ")}
      ORDER BY ${safeSort} ${safeOrder}
      LIMIT ? OFFSET ?`,
      [userId, ...params, Number(limit), Number(offset)]
    );
  },

  // COUNT
  async count({ search = "", status, priority, category_id, view, userId, userRole, task_type, reminder, overdue, upcoming_due, new_today,
    creator_pending, action_required_today, include_closed, department_id, user_id, assigned_by_id, report = false
  }) {
    const where  = ["1=1"];
    const params = [];

    if (search) {
      where.push("(t.title LIKE ? OR t.description LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    if (status)      { where.push("t.status = ?"); params.push(status); }
    if (priority)    { where.push("t.priority = ?"); params.push(priority); }
    if (category_id) { where.push("t.category_id = ?"); params.push(category_id); }
    
    // Assigned By Filter
    if (assigned_by_id) { 
      where.push("t.assigned_by = ?"); 
      params.push(assigned_by_id); 
    }

    // Assigned To (User) Filter L1, current holder, or active assignee
    if (user_id) {
      const { sql, params: viewParams } = assignedToViewClause(user_id);
      where.push(sql);
      params.push(...viewParams);
    }

    // Department Filter
    if (department_id) {
      where.push(`EXISTS (
        SELECT 1 FROM ${M.USERS} u 
        WHERE u.department_id = ? 
        AND u.id IN (t.first_assigned_to, t.current_holder_id, t.assigned_by, t.created_by)
      )`);
      params.push(department_id);
    }

    if (task_type) {
      const types = Array.isArray(task_type) ? task_type : [task_type];
      where.push(`t.task_type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }

    if (!report) {
      if (view === "created")     { where.push("t.created_by = ?"); params.push(userId); }
      if (view === "assigned_to") {
        const { sql, params: viewParams } = assignedToViewClause(userId);
        where.push(sql);
        params.push(...viewParams);
      }
      if (view === "assigned_by") { where.push("t.assigned_by = ?"); params.push(userId); }
      if (view === "holding")     { where.push("t.current_holder_id = ?"); params.push(userId); }
    }
    if (!include_closed) { where.push("t.status != 'closed'"); }

    if (reminder) { where.push("tsn.reminder_at >= CURRENT_DATE"); }
    if (overdue) { where.push("t.due_date < CURRENT_DATE AND t.status NOT IN ('completed','closed')"); }
    if (upcoming_due) { where.push(`DATE(t.due_date) BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '1 day') AND t.status NOT IN ('completed','closed')`); }
    if (new_today) { where.push("DATE(t.created_at) = CURRENT_DATE"); }
    if (creator_pending) { where.push("t.status = 'creator_pending'"); }
    if (action_required_today) {
      where.push(`(
        (t.due_date < CURRENT_DATE AND t.status NOT IN ('completed','closed'))
        OR (t.status = 'creator_pending')
        OR (DATE(t.due_date) = CURRENT_DATE)
        OR (DATE(COALESCE(tsn.reminder_at, t.reminder_date)) = CURRENT_DATE)
        OR (DATE(t.updated_at) = CURRENT_DATE)
        OR (DATE(t.created_at) = CURRENT_DATE)
      )`);
    }

    //  Security Access Clause (ONLY for access control)
    const { clause, values } = await roleFilter(userRole, userId, report);
    if (clause) {
      where.push(clause);
      params.push(...values);
    }

    const rows = await dbQuery(
      `SELECT COUNT(DISTINCT t.task_id) AS total
      FROM task_tasks t
      LEFT JOIN task_self_notes tsn 
        ON tsn.task_id = t.task_id AND tsn.user_id = ?
      WHERE ${where.join(" AND ")}`,
      [userId, ...params]
    );

    return rows[0]?.total ?? 0;
  },

  // STATS
  async getStats({
    userId,
    userRole,
    department_id = null,
    filter_user_id = null,
    assigned_by_id = null,
    report = false,
    view,
    task_type,
    include_closed,
  }) {
    // Security Access Clause (ONLY for access control)
    const { clause, values } = await roleFilter(userRole, userId, report);
    const where = ["1=1"];
    if (clause) where.push(clause);
    const params = [userId, ...values];

    if (task_type) {
      const types = Array.isArray(task_type) ? task_type : [task_type];
      where.push(`t.task_type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }
    
    // Assigned By Filter
    if (assigned_by_id) {
      where.push("t.assigned_by = ?");
      params.push(assigned_by_id);
    }

    // Assigned To (User) Filter L1, current holder, or active assignee
    if (filter_user_id) {
      const { sql, params: viewParams } = assignedToViewClause(filter_user_id);
      where.push(sql);
      params.push(...viewParams);
    }

    // Department Filter
    if (department_id) {
      where.push(`EXISTS (
        SELECT 1 FROM ${M.USERS} u 
        WHERE u.department_id = ? 
        AND u.id IN (t.first_assigned_to, t.current_holder_id, t.assigned_by, t.created_by)
      )`);
      params.push(department_id);
    }

    if (!report) {
      if (view === "created")     { where.push("t.created_by = ?");        params.push(userId); }
      if (view === "assigned_to") {
        const { sql, params: viewParams } = assignedToViewClause(userId);
        where.push(sql);
        params.push(...viewParams);
      }
      if (view === "assigned_by") { where.push("t.assigned_by = ?");       params.push(userId); }
      if (view === "holding")     { where.push("t.current_holder_id = ?"); params.push(userId); }
    }
    if (!include_closed) { where.push("t.status != 'closed'"); }

    const rows = await dbQuery(`
      SELECT
        COUNT(DISTINCT t.task_id) AS total,

        COUNT(DISTINCT CASE WHEN t.status = 'pending' THEN t.task_id END) AS pending,
        COUNT(DISTINCT CASE WHEN t.status = 'in_progress' THEN t.task_id END) AS in_progress,
        COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.task_id END) AS completed,
        COUNT(DISTINCT CASE WHEN t.status = 'creator_pending' THEN t.task_id END) AS creator_pending,

        COUNT(DISTINCT CASE 
          WHEN tsn.reminder_at >= CURRENT_DATE AND t.status != 'completed'
          THEN t.task_id END) AS reminder,

        COUNT(DISTINCT CASE 
          WHEN t.due_date < CURRENT_DATE AND t.status NOT IN ('completed','closed') 
          THEN t.task_id END) AS overdue,

        COUNT(DISTINCT CASE 
          WHEN DATE(t.created_at) = CURRENT_DATE AND t.status != 'completed'
          THEN t.task_id END) AS new_today,

        COUNT(DISTINCT CASE 
          WHEN DATE(t.due_date) BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '1 day')
              AND t.status NOT IN ('completed','closed')
          THEN t.task_id END) AS upcoming_due,

        COUNT(DISTINCT CASE WHEN (
          (t.due_date < CURRENT_DATE AND t.status NOT IN ('completed','closed'))
          OR (DATE(t.due_date) = CURRENT_DATE AND t.status != 'completed')
          OR (DATE(COALESCE(tsn.reminder_at, t.reminder_date)) = CURRENT_DATE AND t.status != 'completed')
          OR (DATE(t.updated_at) = CURRENT_DATE AND t.status != 'completed')
          OR (DATE(t.created_at) = CURRENT_DATE AND t.status != 'completed')
        ) THEN t.task_id END) AS action_required

      FROM task_tasks t
      LEFT JOIN task_self_notes tsn 
        ON tsn.task_id = t.task_id AND tsn.user_id = ?
      WHERE ${where.join(" AND ")}
    `, params);

    return rows[0];
  },

  // GET BY ID   full detail
  async getById(id) {
    const rows = await dbQuery(
      `SELECT
         t.task_id, t.title, t.description, t.priority, t.status, t.task_type,
         t.is_recurring, t.recurrence_type, t.creator_type, t.created_by,

         TO_CHAR(t.due_date,           'YYYY-MM-DD')       AS due_date,
         TO_CHAR(t.reminder_date,      'YYYY-MM-DD')       AS reminder_date,
         TO_CHAR(t.self_reminder_date, 'YYYY-MM-DD')       AS self_reminder_date,
         TO_CHAR(t.completed_at,       'YYYY-MM-DD HH24:MI') AS completed_at,
         TO_CHAR(t.created_at,         'YYYY-MM-DD HH24:MI') AS created_at,
         TO_CHAR(t.updated_at,         'YYYY-MM-DD HH24:MI') AS updated_at,

         t.created_by       AS created_by_id,    cb.name    AS created_by_name,
         CASE
           WHEN t.creator_type = 'super_admin' THEN 'Super Admin'
           WHEN t.creator_type = 'admin'       THEN 'Admin'
           ELSE 'User'
         END AS creator_label,

         t.assigned_by        AS assigned_by_id,        ab.name  AS assigned_by_name,
         t.first_assigned_to  AS first_assigned_to_id,  fa.name  AS first_assigned_to_name,
         t.current_holder_id,                            holder.name AS current_holder_name,
         t.current_assignment_id,

         ca.assignment_level  AS current_assignment_level,
         ca.is_level_one      AS current_is_level_one,

         cat.id               AS category_id,
         cat.name             AS category_name

       FROM task_tasks t
       LEFT JOIN ${M.USERS} cb         ON cb.id     = t.created_by
       LEFT JOIN ${M.USERS} ab         ON ab.id     = t.assigned_by
       LEFT JOIN ${M.USERS} fa         ON fa.id     = t.first_assigned_to
       LEFT JOIN ${M.USERS} holder     ON holder.id = t.current_holder_id
       LEFT JOIN task_assignments ca  ON ca.assignment_id = t.current_assignment_id
       LEFT JOIN task_categories       cat ON cat.id           = t.category_id
       WHERE t.task_id = ?
       LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  },

  // GET ASSIGNMENT CHAIN
  async getAssignmentChain(task_id) {
    return dbQuery(
      `SELECT
         ta.assignment_id, ta.task_id, ta.assignment_level,
         ta.is_level_one, ta.is_active, ta.role,
         ta.parent_assignment_id, ta.note,
         ta.completion_requested_at, ta.completion_approved_at,
         TO_CHAR(ta.assigned_at, 'YYYY-MM-DD HH24:MI') AS assigned_at,

         ta.assigned_by AS assigned_by_id, ab.name   AS assigned_by_name,
         ta.assigned_to AS assigned_to_id, ato.name  AS assigned_to_name,
         ta.approved_by AS approved_by_id, appr.name AS approved_by_name

       FROM task_assignments ta
       LEFT JOIN ${M.USERS} ab   ON ab.id   = ta.assigned_by
       LEFT JOIN ${M.USERS} ato  ON ato.id  = ta.assigned_to
       LEFT JOIN ${M.USERS} appr ON appr.id = ta.approved_by
       WHERE ta.task_id = ?
       ORDER BY ta.assignment_level ASC, ta.assigned_at ASC`,
      [task_id]
    );
  },

  // CREATE ASSIGNED TASK
  async create({ title, description, created_by, creator_type, assigned_by, first_assigned_to, category_id, priority, status, due_date, reminder_date, is_recurring, recurrence_type }) {
    return dbQuery(
      `INSERT INTO task_tasks
         (title, description, task_type,
          created_by, creator_type,
          assigned_by, first_assigned_to, current_holder_id,
          category_id, priority, status,
          due_date, reminder_date,
          is_recurring, recurrence_type)
       VALUES (?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title, description     || null,
        created_by, creator_type || "user",
        assigned_by,
        first_assigned_to, first_assigned_to,
        category_id   || null,
        priority      || "medium",
        status        || "pending",
        due_date      || null,
        reminder_date || null,
        !!is_recurring,
        is_recurring  ? (recurrence_type || null) : null,
      ]
    );
  },

  // CREATE SELF TASK
  async createSelf({ title, description, user_id, user_type, category_id, priority, due_date, self_reminder_date, is_recurring, recurrence_type }) {
    return dbQuery(
      `INSERT INTO task_tasks
         (title, description, task_type,
          created_by, creator_type,
          assigned_by, first_assigned_to, current_holder_id,
          category_id, priority, status,
          due_date, self_reminder_date,
          is_recurring, recurrence_type)
       VALUES (?, ?, 'self', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [
        title, description         || null,
        user_id, user_type,
        user_id, user_id, user_id,
        category_id                || null,
        priority                   || "medium",
        due_date                   || null,
        self_reminder_date         || null,
        !!is_recurring,
        is_recurring ? (recurrence_type || null) : null,
      ]
    );
  },

  // UPDATE general fields
  async update(id, { title, description, category_id, priority, status, due_date, reminder_date, self_reminder_date, is_recurring, recurrence_type }) {
    return dbQuery(
      `UPDATE task_tasks SET
        title              = COALESCE(?, title),
        description        = COALESCE(?, description),
        category_id        = COALESCE(?, category_id),
        priority           = COALESCE(?, priority),
        status             = COALESCE(?, status),
        due_date           = ?,
        reminder_date      = COALESCE(?, reminder_date),
        self_reminder_date = COALESCE(?, self_reminder_date),
        is_recurring       = ?,
        recurrence_type    = ?,
        completed_at       = CASE
                                WHEN ? = 'completed' AND status != 'completed' THEN NOW()
                                WHEN ? != 'completed'                          THEN NULL
                                ELSE completed_at
                              END,
        updated_at         = CURRENT_TIMESTAMP
      WHERE task_id = ?`,
      [
        title?.trim()       || null,
        description?.trim() || null,
        category_id         || null,
        priority            || null,
        status              || null,
        due_date, 
        reminder_date       || null,
        self_reminder_date  || null,
        !!is_recurring,
        is_recurring ? (recurrence_type || null) : null,
        status, status,
        id,
      ]
    );
  },

  // UPDATE STATUS ONLY
  async updateStatus(task_id, status) {
    return dbQuery(
      `UPDATE task_tasks SET status = ?, updated_at = NOW() WHERE task_id = ?`,
      [status, task_id]
    );
  },

  // MARK COMPLETED
  async markCompleted(task_id) {
    return dbQuery(
      `UPDATE task_tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE task_id = ?`,
      [task_id]
    );
  },

  // UPDATE CURRENT HOLDER on forward
  async updateCurrentHolder(task_id, {
    first_assigned_to,
    current_holder_id,
    current_assignment_id,
    status
  }) {

    return dbQuery(
      `UPDATE task_tasks SET
        first_assigned_to     = COALESCE(?, first_assigned_to),
        current_holder_id     = ?,
        current_assignment_id = ?,
        status                = COALESCE(?, status),
        updated_at            = CURRENT_TIMESTAMP
      WHERE task_id = ?`,
      [
        first_assigned_to ?? null,
        current_holder_id ?? null,
        current_assignment_id ?? null,
        status ?? null,
        task_id
      ]
    );
  },
  
  async getAssignmentByUser(task_id, user_id) {
    const result = await dbQuery(
      `SELECT * FROM task_assignments
      WHERE task_id = ? AND assigned_to = ?
      ORDER BY assigned_at DESC LIMIT 1`,
      [task_id, user_id]
    );

    return result[0] || null;
  },

  async updateAssignmentUser(assignment_id, { assigned_to, note }) {
    const result = await dbQuery(
      `UPDATE task_assignments
      SET assigned_to = ?,
          note = ?,
          updated_at = NOW()
      WHERE assignment_id = ?`,
      [assigned_to, note ?? null, assignment_id]
    );

    return result[0];
  },

  // DELETE
  async delete(id) {
    return dbQuery("DELETE FROM task_tasks WHERE task_id = ?", [id]);
  },

  async deleteAssignment(assignment_id) {
    return dbQuery(
      `DELETE FROM task_assignments WHERE assignment_id = ?`,
      [assignment_id]
    );
  },

  // SET CURRENT ASSIGNMENT
  async setCurrentAssignment(task_id, assignment_id) {
    return dbQuery(
      "UPDATE task_tasks SET current_assignment_id = ? WHERE task_id = ?",
      [assignment_id, task_id]
    );
  },

  // CREATE ASSIGNMENT ROW
  async createAssignment({ task_id, assigned_by, assigned_to, level, role, is_level_one, note, parent_assignment_id = null, is_active = true }) {
    return dbQuery(
      `INSERT INTO task_assignments (task_id, assigned_by, assigned_to, assignment_level, role, is_level_one, is_active, parent_assignment_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task_id, 
        assigned_by, 
        assigned_to, 
        level,
        role, 
        !!is_level_one,
        !!is_active,
        parent_assignment_id || null,
        note?.trim() || null,
      ]
    );
  },

  // GET MY ACTIVE ASSIGNMENT
  async getMyActiveAssignment(task_id, user_id) {
    const rows = await dbQuery(
      `SELECT * FROM task_assignments
       WHERE task_id = ? AND assigned_to = ? AND is_active = TRUE
       ORDER BY assigned_at DESC LIMIT 1`,
      [task_id, user_id]
    );
    return rows[0] ?? null;
  },

  // GET ACTIVE L1
  async getActiveL1(task_id) {
    const rows = await dbQuery(
      `SELECT * FROM task_assignments
       WHERE task_id = ? AND role = 'level_one' AND is_active = TRUE
       ORDER BY assigned_at DESC LIMIT 1`,
      [task_id]
    );
    return rows[0] ?? null;
  },

  // GET ASSIGNMENT BY ID
  async getAssignmentById(assignment_id, task_id) {
    const rows = await dbQuery(
      `SELECT * FROM task_assignments
       WHERE assignment_id = ? AND task_id = ?`,
      [assignment_id, task_id]
    );
    return rows[0] ?? null;
  },

  // DEACTIVATE ALL L1
  async deactivateAllL1(task_id) {
    return dbQuery(
      `UPDATE task_assignments SET is_active = FALSE
       WHERE task_id = ? AND role = 'level_one'`,
      [task_id]
    );
  },

  // DEACTIVATE ONE ASSIGNMENT
  async deactivateAssignment(assignment_id) {
    return dbQuery(
      `UPDATE task_assignments SET is_active = FALSE WHERE assignment_id = ?`,
      [assignment_id]
    );
  },

  // GET ACTIVE SUB USERS
  async getActiveSubUsers(task_id) {
    return dbQuery(
      `SELECT assignment_id, assigned_to FROM task_assignments
       WHERE task_id = ? AND role = 'sub_user' AND is_active = TRUE`,
      [task_id]
    );
  },

  async getAllSubUsers(task_id) {
    return dbQuery(
      `SELECT assignment_id, assigned_to, note, is_active 
      FROM task_assignments
      WHERE task_id = ? AND role = 'sub_user'`,
      [task_id]
    );
  },

  // GET PENDING SUB USERS
  async getPendingSubUsers(task_id) {
    //   `SELECT assignment_id, assigned_to FROM task_assignments
    //    WHERE task_id = ? AND role = 'sub_user' AND is_active = TRUE
    //      AND (completion_requested_at IS NULL OR completion_approved_at IS NULL)`,
    //   [task_id]
    // );
    console.log(`SELECT assignment_id, assigned_to FROM task_assignments 
      WHERE task_id = ? 
      AND is_active = TRUE 
      AND role != 'level_one' -- L1 ko chhod kar
      AND (completion_approved_at IS NULL)`, 
      [task_id]);
      console.log(1111);
    return dbQuery(
      `SELECT assignment_id, assigned_to FROM task_assignments 
      WHERE task_id = ? 
      AND is_active = TRUE 
      AND role != 'level_one' -- L1 ko chhod kar
      AND (completion_approved_at IS NULL)`, 
      [task_id]
    );
  },

  // UPDATE SUB USERS PARENT
  async updateSubUsersParent(task_id, new_parent_id) {
    return dbQuery(
      `UPDATE task_assignments SET parent_assignment_id = ?
       WHERE task_id = ? AND role = 'sub_user' AND is_active = TRUE`,
      [new_parent_id, task_id]
    );
  },

  // UPDATE SUB USER NOTE
  async updateSubUserNote(task_id, user_id, note) {
    return dbQuery(
      `UPDATE task_assignments SET note = ?
       WHERE task_id = ? AND assigned_to = ? AND role = 'sub_user'`,
      [note?.trim() || null, task_id, user_id]
    );
  },

  // REQUEST COMPLETION (assignment level)
  async requestAssignmentCompletion(assignment_id) {
    return dbQuery(
      `UPDATE task_assignments SET completion_requested_at = NOW()
       WHERE assignment_id = ?`,
      [assignment_id]
    );
  },

  // APPROVE COMPLETION (assignment level)
  async approveAssignmentCompletion(assignment_id, approved_by) {
    return dbQuery(
      `UPDATE task_assignments SET
         completion_approved_at = NOW(),
         approved_by            = ?,
         is_active              = FALSE
       WHERE assignment_id = ?`,
      [approved_by, assignment_id]
    );
  },

  async rejectAssignmentCompletion(assignment_id) {
    return dbQuery(
      `UPDATE task_assignments SET
         completion_requested_at = NULL,
         is_active               = TRUE
       WHERE assignment_id = ?`,
      [assignment_id]
    );
  },

  async resetL1Completion(assignmentId) {
    await dbQuery(
      `UPDATE task_assignments
      SET completion_requested_at = NULL,
          completion_approved_at  = NULL
      WHERE assignment_id = ?`,
      [assignmentId]
    );
  },

  // APPROVE ALL L1 creator approved, mark L1 done
  async approveAllL1(task_id, approved_by) {
    return dbQuery(
      `UPDATE task_assignments SET
         completion_approved_at = NOW(),
         approved_by            = ?,
         is_active              = FALSE
       WHERE task_id = ? AND role = 'level_one'`,
      [approved_by, task_id]
    );
  },

  async getLatestL1User(task_id) {
    const rows = await dbQuery(
      `SELECT assigned_to FROM task_assignments
       WHERE task_id = ? AND role = 'level_one'
       ORDER BY assigned_at DESC LIMIT 1`,
      [task_id]
    );
    return rows[0] ?? null;
  },

  async addChatMessage(task_id, user_id, message, attachments = null) {
    return dbQuery(
      `INSERT INTO task_chat (task_id, user_id, message, attachments)
       VALUES (?, ?, ?, ?)`,
      [
        task_id, user_id,
        message || null,
        attachments ? JSON.stringify(attachments) : null,
      ]
    );
  },

  // CHAT get all messages
  async getChatMessages(task_id, current_user_id) {
    return dbQuery(
      `SELECT
         c.chat_id, c.task_id, c.user_id,
         c.message, c.reply_to_id, c.attachments,
         TO_CHAR(c.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
         u.name AS sender_name,
         u.type AS sender_type,
         (c.user_id = ?) AS is_own,
         rp.message AS reply_message,
         rp.user_id AS reply_user_id,
         ru.name    AS reply_sender_name
       FROM task_chat c
       JOIN ${M.USERS} u ON u.id = c.user_id
       LEFT JOIN task_chat rp ON rp.chat_id = c.reply_to_id
       LEFT JOIN ${M.USERS}    ru ON ru.id       = rp.user_id
       WHERE c.task_id = ?
       ORDER BY c.created_at ASC`,
      [current_user_id, task_id]
    );
  },

  // CHAT get single message
  async getChatMessageById(chat_id, task_id) {
    const rows = await dbQuery(
      `SELECT c.*, u.name AS sender_name, u.type AS sender_type
       FROM task_chat c
       JOIN ${M.USERS} u ON u.id = c.user_id
       WHERE c.chat_id = ? AND c.task_id = ?`,
      [chat_id, task_id]
    );
    return rows[0] ?? null;
  },

  // CHAT validate reply_to_id
  async getChatById(chat_id, task_id) {
    const rows = await dbQuery(
      "SELECT chat_id FROM task_chat WHERE chat_id = ? AND task_id = ?",
      [chat_id, task_id]
    );
    return rows[0] ?? null;
  },

  // CHAT delete message
  async deleteChatMessage(chat_id) {
    return dbQuery("DELETE FROM task_chat WHERE chat_id = ?", [chat_id]);
  },

  // SELF NOTE get
  async getSelfNote(task_id, user_id) {
    const rows = await dbQuery(
      `SELECT
        self_note_id, task_id, user_id, note, reminder_at, attachments,
        TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
        TO_CHAR(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
      FROM task_self_notes
      WHERE task_id = ? AND user_id = ?`,
      [task_id, user_id]
    );
    return rows[0] ?? null;
  },

  // SELF NOTE upsert
  async upsertSelfNote(task_id, user_id, note, reminder_at, attachments) {
    const attachJson = attachments?.length > 0
      ? JSON.stringify(attachments) : null;
    return dbQuery(
      `INSERT INTO task_self_notes (task_id, user_id, note, reminder_at, attachments)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (task_id, user_id) DO UPDATE SET
        note        = EXCLUDED.note,
        reminder_at = EXCLUDED.reminder_at,
        attachments = EXCLUDED.attachments,
        updated_at  = CURRENT_TIMESTAMP`,
      [task_id, user_id, note?.trim() || null, reminder_at || null, attachJson]
    );
  },

  // SELF NOTE delete
  async deleteSelfNote(task_id, user_id) {
    return dbQuery(
      "DELETE FROM task_self_notes WHERE task_id = ? AND user_id = ?",
      [task_id, user_id]
    );
  },

  async getSelfNoteRaw(task_id, user_id) {
    const rows = await dbQuery(
      "SELECT * FROM task_self_notes WHERE task_id = ? AND user_id = ?",
      [task_id, user_id]
    );
    return rows[0] ?? null;
  },

  // GET USER BY ID active user
  async getUserById(user_id) {
    const rows = await dbQuery(
      `SELECT id, name, type FROM ${M.USERS} WHERE id = ? AND status = 'active'`,
      [user_id]
    );
    return rows[0] ?? null;
  },

  // GET CATEGORY BY ID
  async getCategoryById(category_id) {
    const rows = await dbQuery(
      "SELECT id, name FROM task_categories WHERE id = ?",
      [category_id]
    );
    return rows[0] ?? null;
  },

  async getActiveL1ByUser(task_id, user_id) {
    console.log(`SELECT * FROM task_assignments
       WHERE task_id = ? AND assigned_to = ? AND role = 'level_one' AND is_active = TRUE`,
      [task_id, user_id]);

    const rows = await dbQuery(
      `SELECT * FROM task_assignments
       WHERE task_id = ? AND assigned_to = ? AND role = 'level_one' AND is_active = TRUE`,
      [task_id, user_id]
    );
    return rows[0] ?? null;
  },

  async getActiveSubUserAssignment(task_id, user_id) {
    const rows = await dbQuery(
      `SELECT assignment_id FROM task_assignments
       WHERE task_id = ? AND assigned_to = ? AND is_active = TRUE AND role = 'sub_user'`,
      [task_id, user_id]
    );
    return rows[0] ?? null;
  },

  async getSubUserAssignment(task_id, user_id) {
    const rows = await dbQuery(
      `SELECT assignment_id, assigned_to, note, is_active
       FROM task_assignments
       WHERE task_id = ? AND assigned_to = ? AND role = 'sub_user'
       ORDER BY assigned_at DESC
       LIMIT 1`,
      [task_id, user_id]
    );
    return rows[0] ?? null;
  },

  // DELETE RECURRING
  async deleteRecurring(task_id) {
    return dbQuery(
      "DELETE FROM task_recurring_tasks WHERE task_id = ?",
      [task_id]
    );
  },

  // ADD ACTIVITY LOG
  async addLog(task_id, user_id, performed_by, action, action_detail = null, assignment_id = null) {
    return dbQuery(
      `INSERT INTO task_log (task_id, assignment_id, user_id, performed_by, action, action_detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [task_id, assignment_id ?? null, user_id, performed_by, action, action_detail ?? null]
    ).catch(() => {});
  },

  // GET ACTIVITY LOG
  // async getActivityLog(task_id, order = "ASC") {
  //     `SELECT
  //        tl.activity_id, tl.action, tl.action_detail, tl.performed_by,
  //        DATE_FORMAT(tl.action_time, '%Y-%m-%d %H:%i:%s') AS action_time,
  //        tl.user_id, tl.assignment_id
  //      FROM task_log tl
  //      WHERE tl.task_id = ?
  //      ORDER BY tl.action_time ${safeOrder}, tl.activity_id ${safeOrder}`,
  //     [task_id]
  //   );
  // },

  // Activity log paginated
  async getLogCount(taskId) {
    const result = await dbQuery(
      `SELECT COUNT(*) as total FROM task_log WHERE task_id = ?`, 
      [taskId]
    );
    return result[0]?.total || 0;
  },

  async getActivityLog(taskId, { limit = 2000, offset = 0, action_type = null } = {}) {
    let sql = `
      SELECT
        tl.activity_id, tl.action, tl.action_detail,
        tl.action_time, tl.assignment_id,
        u.name AS performed_by
      FROM task_log tl
      LEFT JOIN ${M.USERS} u ON u.id = tl.user_id
      WHERE tl.task_id = ?
    `;
    const params = [taskId];

    if (action_type) {
      sql += ` AND tl.action = ?`;
      params.push(action_type);
    }

    sql += ` ORDER BY tl.action_time DESC LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    return await dbQuery(sql, params);
  },

  async getActivityLogCount(taskId, action_type = null) {
    let sql = `SELECT COUNT(*) as total FROM task_log WHERE task_id = ?`;
    const params = [taskId];
    
    if (action_type) { 
      sql += ` AND action = ?`; 
      params.push(action_type); 
    }
    
    const result = await dbQuery(sql, params);
    return result[0]?.total || 0;
  },

  async getChatAttachments(task_id) {
    return dbQuery(
      "SELECT attachments FROM task_chat WHERE task_id = ? AND attachments IS NOT NULL",
      [task_id]
    );
  },

  async getSelfNoteAttachments(task_id) {
    return dbQuery(
      "SELECT attachments FROM task_self_notes WHERE task_id = ? AND attachments IS NOT NULL",
      [task_id]
    );
  },

  // SEND CHAT MESSAGE WITH REPLY
  async sendChatMessage(task_id, user_id, message, reply_to_id, attachments) {
    const attachJson = attachments?.length > 0 ? JSON.stringify(attachments) : null;
    return dbQuery(
      `INSERT INTO task_chat (task_id, user_id, message, reply_to_id, attachments)
       VALUES (?, ?, ?, ?, ?)`,
      [task_id, user_id, message?.trim() || null, reply_to_id || null, attachJson]
    );
  },

  // GET CHAT MESSAGE WITH SENDER (after insert)
  async getChatMessageWithSender(chat_id, current_user_id) {
    const rows = await dbQuery(
      `SELECT c.*, u.name AS sender_name, u.type AS sender_type,
              (c.user_id = ?) AS is_own
       FROM task_chat c
       JOIN ${M.USERS} u ON u.id = c.user_id
       WHERE c.chat_id = ?`,
      [current_user_id, chat_id]
    );
    return rows[0] ?? null;
  },

  async getRawChatMessage(chat_id, task_id) {
    const rows = await dbQuery(
      "SELECT * FROM task_chat WHERE chat_id = ? AND task_id = ?",
      [chat_id, task_id]
    );
    return rows[0] ?? null;
  },

  async checkUserTaskAccess(taskId, userId, userRole) {
    if (userRole === "super_admin" || userRole === "admin") return true;

    const sql = `
      SELECT 1 FROM task_tasks t
      LEFT JOIN task_assignments ta ON t.task_id = ta.task_id
      WHERE t.task_id = ?
      AND (
        t.created_by           = ?
        OR t.first_assigned_to = ?
        OR t.current_holder_id = ?
        OR t.assigned_by       = ?
        OR ta.assigned_to      = ?
        OR ta.assigned_by      = ?
      )
      LIMIT 1`;

    const result = await dbQuery(sql, [taskId, userId, userId, userId, userId, userId, userId]);
    return result.length > 0;
  },

  async checkManagerTaskAccess(task_id, department_id) {
    const result = await dbQuery(
      `SELECT 1 FROM task_assignments ta
      JOIN ${M.USERS} u ON u.id = ta.assigned_to
      WHERE ta.task_id = ?
        AND u.department_id = ?
      LIMIT 1`,
      [task_id, department_id]
    );
    return result.length > 0;
  },

  async checkTaskCreator(taskId, userId) {
      const result = await dbQuery(
          `SELECT 1 FROM task_tasks 
          WHERE task_id = ? AND created_by = ?
          LIMIT 1`,
          [taskId, userId]
      );
      return result.length > 0;
  },

  async updateAssignedBy(task_id, assigned_by) {
    return dbQuery(
      `UPDATE task_tasks SET assigned_by = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`,
      [assigned_by, task_id]
    );
  },
  
  async updateL1AssignedBy(task_id, assigned_by) {
    return dbQuery(`UPDATE task_assignments SET assigned_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND is_level_one = TRUE AND is_active = TRUE`,
      [assigned_by, task_id]
    );
  },

  // UPDATE ACTIVE STATUS ONLY
  async updateActiveStatus(recurringId, is_active) {
    return dbQuery(
      `UPDATE task_recurring_tasks SET is_active = ?, updated_at = NOW() WHERE recurring_id = ?`,
      [is_active, recurringId]
    );
  },

  // GET single recurring task by id
  async getRecurringTaskById(recurringId) {
    const result = await dbQuery(
      `SELECT * FROM task_recurring_tasks WHERE recurring_id = ?`,
      [recurringId]
    );
    return result[0] ?? null;
  },

};

export default Task;