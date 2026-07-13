import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";
import { migrateTableAuditColumnsToUserNames } from "../../../../config/auditUserNameColumns.js";

export async function createTrainingVideosTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TRAINING_VIDEOS} (
      id               SERIAL PRIMARY KEY,
      module_id        INTEGER NOT NULL REFERENCES ${T.MODULES}(id) ON DELETE CASCADE,
      title            VARCHAR(200) NOT NULL,
      description      TEXT,
      video_url        TEXT NOT NULL,
      permission_type  VARCHAR(20) NOT NULL CHECK (permission_type IN ('view', 'add', 'edit', 'delete', 'authorize')),
      is_active        BOOLEAN DEFAULT true,
      approved         BOOLEAN DEFAULT false,
      approved_by      TEXT,
      approved_at      TIMESTAMP,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP
    );
  `);

  // ONE-TIME: INT id → user name. After prod OK, remove this call.
  await migrateTableAuditColumnsToUserNames(dbQuery, T.TRAINING_VIDEOS);
}
