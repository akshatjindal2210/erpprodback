import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskAppConfigTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.APP_CONFIG} (
      config_key   VARCHAR(120) PRIMARY KEY,
      config_value TEXT NOT NULL,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_by   INT REFERENCES ${C.USERS}(id) ON DELETE SET NULL
    );
  `);
}
