import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";
import { migrateTableAuditColumnsToUserNames } from "../../../../config/auditUserNameColumns.js";

export async function createModuleSopsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MODULE_SOPS} (
      id               SERIAL PRIMARY KEY,
      module_id        INTEGER NOT NULL REFERENCES ${T.MODULES}(id) ON DELETE CASCADE,
      permission_type  VARCHAR(20) NOT NULL CHECK (permission_type IN ('view', 'add', 'edit', 'delete', 'authorize')),
      description      TEXT,
      is_required      BOOLEAN NOT NULL DEFAULT false,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS module_sops_module_perm_live_unique
      ON ${T.MODULE_SOPS} (module_id, permission_type)
      WHERE is_deleted = false;
  `);

  // ONE-TIME: INT id → user name. After prod OK, remove this call.
  await migrateTableAuditColumnsToUserNames(dbQuery, T.MODULE_SOPS, {
    columns: ["created_by", "updated_by", "deleted_by"],
  });
}
