import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";

export async function createModulesTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MODULES} (
      id            INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      name          VARCHAR(100) UNIQUE NOT NULL,
      label         VARCHAR(100) NOT NULL,
      app_type      VARCHAR(50) NOT NULL DEFAULT 'core',
      sort_order    VARCHAR(20) NOT NULL DEFAULT '0',
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by    INTEGER REFERENCES ${T.USERS}(id) ON DELETE SET NULL,
      updated_at    TIMESTAMP
    );
  `);
}