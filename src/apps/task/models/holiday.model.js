import dbQuery from "../shared/db.js";

const Holiday = {
  tableName: "task_holiday",

  async getAll({ search, page, limit, sortBy, order, dateFrom, dateTo }) {
    const offset       = (Number(page) - 1) * Number(limit);
    const validColumns = ["id", "name", "date", "created_at"];
    const finalSort    = validColumns.includes(sortBy) ? sortBy : "id";
    const finalOrder   = order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

    let query       = `SELECT id, name, TO_CHAR(date, 'YYYY-MM-DD') as date, created_at, updated_at FROM ${this.tableName} WHERE name LIKE ?`;
    let queryParams = [`%${search}%`];

    if (dateFrom && dateTo) {
      query += ` AND date BETWEEN ? AND ?`;
      queryParams.push(dateFrom, dateTo);
    }

    query += ` ORDER BY ${finalSort} ${finalOrder} LIMIT ? OFFSET ?`;
    queryParams.push(Number(limit), Number(offset));

    return await dbQuery(query, queryParams);
  },

  async count({ search, dateFrom, dateTo }) {
    let query       = `SELECT COUNT(*) as total FROM ${this.tableName} WHERE name LIKE ?`;
    let queryParams = [`%${search}%`];

    if (dateFrom && dateTo) {
      query += ` AND date BETWEEN ? AND ?`;
      queryParams.push(dateFrom, dateTo);
    }

    const rows = await dbQuery(query, queryParams);
    return rows[0]?.total ?? 0;
  },

  async getById(id) {
    return await dbQuery(
      `SELECT id, name, TO_CHAR(date, 'YYYY-MM-DD') as date, created_at, updated_at FROM ${this.tableName} WHERE id = ?`,
      [id]
    );
  },

  async create({ name, date }) {
    return await dbQuery(
      `INSERT INTO ${this.tableName} (name, date) VALUES (?, ?)`,
      [name, date],
    );
  },

  async update(id, { name, date }) {
    return await dbQuery(
      `UPDATE ${this.tableName} SET name = ?, date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [name, date, id],
    );
  },

  async delete(id) {
    return await dbQuery(`DELETE FROM ${this.tableName} WHERE id = ?`, [id]);
  },

  async bulkCreate(rows) {
    if (!rows.length) return { affectedRows: 0 };

    const placeholders = rows.map(() => "(?, ?)").join(", ");
    const values       = rows.flatMap(({ name, date }) => [name, date]);

    return await dbQuery(
      `INSERT INTO ${this.tableName} (name, date) VALUES ${placeholders} ON CONFLICT (name) DO NOTHING`,
      values,
    );
  },
};

export default Holiday;