import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";

export async function createDepartmentsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.DEPARTMENTS} (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
