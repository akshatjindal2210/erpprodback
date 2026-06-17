import dbQuery from "../shared/db.js";
import { TASK_TABLES as T } from "../../../config/dbTables.js";

const RedTicket = {
  async getAll({
    search = "",
    page = 1,
    limit = 20,
    department_id,
    designation_id,
    person_id,
    date_from,
    date_to,
  } = {}) {
    const offset = (page - 1) * limit;
    const params = [];
    let where = "WHERE 1=1";

    if (search?.trim()) {
      params.push(`%${search.trim()}%`, `%${search.trim()}%`);
      where += " AND (rt.title ILIKE ? OR rt.description ILIKE ?)";
    }
    if (department_id) { params.push(Number(department_id)); where += " AND rt.department_id = ?"; }
    if (designation_id) { params.push(Number(designation_id)); where += " AND rt.designation_id = ?"; }
    if (person_id) { params.push(Number(person_id)); where += " AND rt.person_id = ?"; }
    if (date_from) { params.push(date_from); where += " AND rt.ticket_date >= ?"; }
    if (date_to) { params.push(date_to); where += " AND rt.ticket_date <= ?"; }

    const listParams = [...params, limit, offset];
    const rows = await dbQuery(
      `SELECT rt.ticket_id, rt.title, rt.description, rt.priority, rt.status,
              rt.department_id, rt.designation_id, rt.person_id, rt.score_penalty,
              rt.cl_instance_id, rt.task_id,
              TO_CHAR(rt.ticket_date, 'YYYY-MM-DD') AS ticket_date,
              rt.created_by, u.name AS created_by_name,
              d.name AS department_name, des.name AS designation_name, p.name AS person_name,
              TO_CHAR(rt.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
              TO_CHAR(rt.updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
       FROM ${T.RED_TICKETS} rt
       LEFT JOIN mst_users u ON u.id = rt.created_by
       LEFT JOIN mst_departments d ON d.id = rt.department_id
       LEFT JOIN mst_designations des ON des.id = rt.designation_id
       LEFT JOIN mst_users p ON p.id = rt.person_id
       ${where}
       ORDER BY rt.ticket_date DESC, rt.ticket_id DESC
       LIMIT ? OFFSET ?`,
      listParams
    );

    const countRows = await dbQuery(
      `SELECT COUNT(*)::int AS total FROM ${T.RED_TICKETS} rt ${where}`,
      params
    );
    return { items: rows, total: countRows[0]?.total ?? 0 };
  },

  async getById(id) {
    const rows = await dbQuery(
      `SELECT rt.*, u.name AS created_by_name,
              d.name AS department_name, des.name AS designation_name, p.name AS person_name,
              TO_CHAR(rt.ticket_date, 'YYYY-MM-DD') AS ticket_date_fmt,
              TO_CHAR(rt.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
              TO_CHAR(rt.updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
       FROM ${T.RED_TICKETS} rt
       LEFT JOIN mst_users u ON u.id = rt.created_by
       LEFT JOIN mst_departments d ON d.id = rt.department_id
       LEFT JOIN mst_designations des ON des.id = rt.designation_id
       LEFT JOIN mst_users p ON p.id = rt.person_id
       WHERE rt.ticket_id = ?
       LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  },

  async create(data) {
    const rows = await dbQuery(
      `INSERT INTO ${T.RED_TICKETS}
         (title, description, priority, status, created_by,
          department_id, designation_id, person_id, score_penalty,
          cl_instance_id, task_id, ticket_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ticket_id`,
      [
        data.title,
        data.description ?? null,
        data.priority ?? "medium",
        data.status ?? "open",
        data.created_by,
        data.department_id ?? null,
        data.designation_id ?? null,
        data.person_id ?? null,
        Math.max(0, Number(data.score_penalty) || 0),
        data.cl_instance_id ?? null,
        data.task_id ?? null,
        data.ticket_date ?? new Date().toISOString().slice(0, 10),
      ]
    );
    return rows[0]?.ticket_id;
  },

  async update(id, data) {
    await dbQuery(
      `UPDATE ${T.RED_TICKETS}
       SET title = COALESCE(?, title),
           description = COALESCE(?, description),
           priority = COALESCE(?, priority),
           status = COALESCE(?, status),
           department_id = COALESCE(?, department_id),
           designation_id = COALESCE(?, designation_id),
           person_id = COALESCE(?, person_id),
           score_penalty = COALESCE(?, score_penalty),
           cl_instance_id = COALESCE(?, cl_instance_id),
           task_id = COALESCE(?, task_id),
           ticket_date = COALESCE(?, ticket_date),
           updated_at = CURRENT_TIMESTAMP
       WHERE ticket_id = ?`,
      [
        data.title ?? null,
        data.description ?? null,
        data.priority ?? null,
        data.status ?? null,
        data.department_id ?? null,
        data.designation_id ?? null,
        data.person_id ?? null,
        data.score_penalty != null ? Math.max(0, Number(data.score_penalty)) : null,
        data.cl_instance_id ?? null,
        data.task_id ?? null,
        data.ticket_date ?? null,
        id,
      ]
    );
  },

  async delete(id) {
    await dbQuery(`DELETE FROM ${T.RED_TICKETS} WHERE ticket_id = ?`, [id]);
  },
};

export default RedTicket;
