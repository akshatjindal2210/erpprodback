import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createAppConfigTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.APP_CONFIG} (
      config_key   VARCHAR(120) PRIMARY KEY,
      config_value TEXT NOT NULL,
      updated_at   TIMESTAMP DEFAULT NOW(),
      updated_by   INTEGER REFERENCES ${C.USERS}(id)
    );
  `);
}
