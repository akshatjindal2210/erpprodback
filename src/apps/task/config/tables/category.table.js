import dbQuery from "../../shared/db.js";
import { TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskCategoriesTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.CATEGORIES} (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
