import dbQuery from "../../shared/db.js";
import { TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskHolidayTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.HOLIDAY} (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) UNIQUE NOT NULL,
      date       DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
