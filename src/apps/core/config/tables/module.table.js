import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";
import { migrateTableAuditColumnsToUserNames } from "../../../../config/auditUserNameColumns.js";

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
      updated_by    TEXT,
      updated_at    TIMESTAMP
    );
  `);

  // ONE-TIME: INT id → user name. After prod OK, remove this call.
  await migrateTableAuditColumnsToUserNames(dbQuery, T.MODULES, {
    columns: ["updated_by"],
  });
}
