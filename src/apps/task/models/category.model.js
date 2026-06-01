import dbQuery from "../shared/db.js";

const Category = {
  tableName: "task_categories",

  async getAll({ search, page, limit, sortBy, order, dateFrom, dateTo }) {
    const offset      = (Number(page) - 1) * Number(limit);
    const validColumns = ["id", "name", "created_at"];
    const finalSort   = validColumns.includes(sortBy) ? sortBy : "id";
    const finalOrder  = order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

    let query       = `SELECT * FROM ${this.tableName} WHERE name LIKE ?`;
    let queryParams = [`%${search}%`];

    if (dateFrom && dateTo) {
      query += ` AND DATE(created_at) BETWEEN ? AND ?`;
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
      query += ` AND DATE(created_at) BETWEEN ? AND ?`;
      queryParams.push(dateFrom, dateTo);
    }

    const rows = await dbQuery(query, queryParams);
    return rows[0]?.total ?? 0;
  },

  async getById(id) {
    return await dbQuery(`SELECT * FROM ${this.tableName} WHERE id = ?`, [id]);
  },

  async create({ name }) {
    return await dbQuery(`INSERT INTO ${this.tableName} (name) VALUES (?)`, [name]);
  },

  async update(id, { name }) {
    return await dbQuery(
      `UPDATE ${this.tableName} SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [name, id],
    );
  },

  async delete(id) {
    return await dbQuery(`DELETE FROM ${this.tableName} WHERE id = ?`, [id]);
  },
};

export default Category;