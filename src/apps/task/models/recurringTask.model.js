import dbQuery from "../shared/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { asArray } from "../shared/utils/helper.js";

const RecurringTask = {
  tableName: "task_recurring_tasks",

  async getAll({ search, page = 1, limit = 10, sortBy, order, dateFrom, dateTo, user_id, requestingUser } = {}) {
    const offset = (Number(page) - 1) * Number(limit);
    const finalLimit = Math.min(Number(limit) || 10, 100);

    const validColumns = ["recurring_id", "recurrence_type", "next_occurrence", "created_at"];
    const finalSort  = validColumns.includes(sortBy) ? sortBy : "recurring_id";
    const finalOrder = order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

    let query = `SELECT * FROM ${this.tableName} WHERE 1=1`;
    const queryParams = [];

    if (search) {
      query += ` AND title LIKE ?`;
      queryParams.push(`%${search}%`);
    }

    if (dateFrom && dateTo) {
      query += ` AND DATE(created_at) BETWEEN ? AND ?`;
      queryParams.push(dateFrom, dateTo);
    }

    if (user_id) {
      query += ` AND created_by = ?`;
      queryParams.push(user_id);
    } else if (requestingUser) {
      query += ` AND created_by = ?`;
      queryParams.push(requestingUser.id);
    }

    query += ` ORDER BY ${finalSort} ${finalOrder} LIMIT ? OFFSET ?`;
    queryParams.push(finalLimit, Number(offset));

    return await dbQuery(query, queryParams);
  },

  async count({ search, dateFrom, dateTo, is_active, user_id, requestingUser } = {}) {
    let query = `SELECT COUNT(*) AS total FROM ${this.tableName} WHERE 1=1`;
    const queryParams = [];

    if (typeof is_active === "boolean") {
      query += ` AND is_active = ?`;
      queryParams.push(is_active);
    }

    if (search) {
      query += ` AND title LIKE ?`;
      queryParams.push(`%${search}%`);
    }

    if (dateFrom && dateTo) {
      query += ` AND DATE(created_at) BETWEEN ? AND ?`;
      queryParams.push(dateFrom, dateTo);
    }

    if (user_id) {
      query += ` AND created_by = ?`;
      queryParams.push(user_id);
    } else if (requestingUser) {
      query += ` AND created_by = ?`;
      queryParams.push(requestingUser.id);
    }

    const rows = await dbQuery(query, queryParams);
    return rows[0]?.total ?? 0;
  },

  async getStats({ search, dateFrom, dateTo, user_id, requestingUser } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      total:    await this.count({ search, dateFrom, dateTo, user_id, requestingUser }),
      active:   await this.count({ search, dateFrom, dateTo, is_active: true,  user_id, requestingUser }),
      inactive: await this.count({ search, dateFrom, dateTo, is_active: false, user_id, requestingUser }),
      today:    await this.count({ search, dateFrom: today, dateTo: today, user_id, requestingUser }),
    };
  },

  async getById(id) {
    const rows = await dbQuery(
      `SELECT 
          t.*,
          cb.name AS created_by_name,
          ab.name AS assigned_by_name,
          at.name AS assigned_to_name,
          cat.name AS category_name,
          rta.assignment_id,
          rta.assigned_by AS sub_assigned_by,
          rta.assigned_to AS sub_assigned_to,
          rta.role AS sub_role,
          rta.is_level_one AS sub_is_level_one,
          rta.assignment_level AS sub_level,
          rta.parent_assignment_id AS sub_parent_id,
          u_sub.name AS sub_user_name
      FROM ${this.tableName} t
      LEFT JOIN ${M.USERS} cb ON cb.id = t.created_by
      LEFT JOIN ${M.USERS} ab ON ab.id = t.assigned_by
      LEFT JOIN ${M.USERS} at ON at.id = t.assigned_to
      LEFT JOIN task_categories cat ON cat.id = t.category_id
      LEFT JOIN task_recurring_task_assignments rta ON rta.recurring_id = t.recurring_id
      LEFT JOIN ${M.USERS} u_sub ON u_sub.id = rta.assigned_to
      WHERE t.recurring_id = ?`,
      [id]
    );

    if (!rows || rows.length === 0) return null;

    const parseJSON = val => {
      if (!val) return [];
      if (typeof val !== "string") return val;
      try { return JSON.parse(val); } catch { return []; }
    };

    // Fetch chat
    const chatRows = await dbQuery(
      `SELECT chat_id, user_id, message, attachments, created_at
       FROM task_recurring_task_chat WHERE recurring_id = ?`,
      [id]
    );

    const chatMessages = chatRows.map(c => ({
      ...c,
      attachments: c.attachments ? (typeof c.attachments === "string" ? JSON.parse(c.attachments) : c.attachments) : []
    }));

    return {
      ...rows[0],
      is_recurring: true,
      recurrence_weekdays: parseJSON(rows[0].recurrence_weekdays),
      recurrence_month_dates: parseJSON(rows[0].recurrence_month_dates),
      recurrence_year_dates: parseJSON(rows[0].recurrence_year_dates),
      sub_users: rows
        .filter(r => r.sub_user_name)
        .map(r => ({
          assignment_id: r.assignment_id,
          assigned_by: r.sub_assigned_by,
          assigned_to: r.sub_assigned_to,
          name: r.sub_user_name,
          role: r.sub_role,
          is_level_one: !!r.sub_is_level_one,
          level: r.sub_level,
          parent_assignment_id: r.sub_parent_id
        })),
      chat: chatMessages
    };
  },

  async create(data) {
    const {
      title, description = null, task_type = "self",
      created_by, assigned_by = null, assigned_to,
      category_id = null, priority = "medium",
      recurrence_type, recurrence_weekdays = null,
      recurrence_month_dates = null, recurrence_year_dates = null,
      next_occurrence, end_date = null
    } = data;

    const jsonOrNull = val => val === undefined || val === null ? null : (typeof val === "string" ? val : JSON.stringify(val));

    return await dbQuery(
      `INSERT INTO ${this.tableName} 
       (title, description, task_type, created_by, assigned_by, assigned_to, category_id, priority,
        recurrence_type, recurrence_weekdays, recurrence_month_dates, recurrence_year_dates,
        next_occurrence, end_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title, description, task_type, created_by, assigned_by, assigned_to,
        category_id, priority, recurrence_type,
        jsonOrNull(recurrence_weekdays),
        jsonOrNull(recurrence_month_dates),
        jsonOrNull(recurrence_year_dates),
        next_occurrence, end_date
      ]
    );
  },

  async update(id, data) {
      const fields = [];
      const values = [];

      const jsonFields = ["recurrence_weekdays", "recurrence_month_dates", "recurrence_year_dates"];

      for (const [key, value] of Object.entries(data)) {
        fields.push(`${key} = ?`);
        values.push(jsonFields.includes(key) ? JSON.stringify(value) : value);
      }

      values.push(id);

      // Don't manually include updated_at in the query
      return await dbQuery(
        `UPDATE ${this.tableName} SET ${fields.join(", ")} WHERE recurring_id = ?`,
        values
      );
  },
  
  async delete(id) {
    return await dbQuery(`DELETE FROM ${this.tableName} WHERE recurring_id = ?`, [id]);
  },

  async createAssignment({ recurring_id, assigned_by, assigned_to, role, is_level_one, parent_assignment_id = null, note = null }) {
    return await dbQuery(
      `INSERT INTO task_recurring_task_assignments 
       (recurring_id, assigned_by, assigned_to, role, is_level_one, parent_assignment_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [recurring_id, assigned_by, assigned_to, role, !!is_level_one, parent_assignment_id, note]
    );
  },

  async addChatMessage(recurring_id, user_id, message = null, attachments = []) {
    const list = asArray(attachments);
    return await dbQuery(
      `INSERT INTO task_recurring_task_chat (recurring_id, user_id, message, attachments)
       VALUES (?, ?, ?, ?)`,
      [recurring_id, user_id, message, list.length ? JSON.stringify(list) : null]
    );
  },

  async deactivateAllL1(recurring_id) {
    return await dbQuery(
      `UPDATE task_recurring_task_assignments 
      SET is_active = FALSE 
      WHERE recurring_id = ? AND is_level_one = TRUE`,
      [recurring_id]
    );
  },

  async getAllSubUsers(recurring_id) {
    return await dbQuery(
      `SELECT * FROM task_recurring_task_assignments 
      WHERE recurring_id = ? AND is_level_one = FALSE`,
      [recurring_id]
    );
  },

  async updateSubUserNote(recurring_id, user_id, note) {
    return await dbQuery(
      `UPDATE task_recurring_task_assignments 
      SET note = ? 
      WHERE recurring_id = ? AND assigned_to = ?`,
      [note, recurring_id, user_id]
    );
  },

  async updateSubUsersParent(recurring_id, parent_assignment_id) {
    return await dbQuery(
      `UPDATE task_recurring_task_assignments
      SET parent_assignment_id = ?
      WHERE recurring_id = ? AND is_level_one = FALSE`,
      [parent_assignment_id, recurring_id]
    );
  },

  async getActiveL1(recurring_id) {
    const rows = await dbQuery(
      `SELECT * FROM task_recurring_task_assignments 
      WHERE recurring_id = ? AND is_level_one = TRUE LIMIT 1`,
      [recurring_id]
    );
    return rows[0] ?? null;
  },

  async getUserById(user_id) {
    const rows = await dbQuery(
      `SELECT id, name FROM ${M.USERS} WHERE id = ?`,
      [user_id]
    );
    return rows[0] ?? null;
  },

  async deleteAssignment(assignment_id) {
    return await dbQuery(
      `DELETE FROM task_recurring_task_assignments WHERE assignment_id = ?`,
      [assignment_id]
    );
  },

  async getChatAttachments(recurring_id) {
    return await dbQuery(
      `SELECT chat_id, attachments FROM task_recurring_task_chat 
      WHERE recurring_id = ? AND attachments IS NOT NULL`,
      [recurring_id]
    );
  },

  async updateChatAttachments(chat_id, attachments) {
    const list = asArray(attachments);
    return await dbQuery(
      `UPDATE task_recurring_task_chat SET attachments = ? WHERE chat_id = ?`,
      [list.length > 0 ? JSON.stringify(list) : null, chat_id]
    );
  },

  async updateOrAddChatMessage(recurring_id, user_id, message) {
    const rows = await dbQuery(
      `SELECT chat_id FROM task_recurring_task_chat 
      WHERE recurring_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [recurring_id, user_id]
    );

    if (rows.length > 0) {
      const chat_id = rows[0].chat_id;
      return await dbQuery(
        `UPDATE task_recurring_task_chat SET message = ? WHERE chat_id = ?`,
        [message, chat_id]
      );
    } else {
      return await this.addChatMessage(recurring_id, user_id, message, []);
    }
  }
};

export default RecurringTask;