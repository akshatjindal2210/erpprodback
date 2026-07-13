import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";
import { migrateTableAuditColumnsToUserNames } from "../../../../config/auditUserNameColumns.js";

export async function createStickerTypeTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.STICKER_TYPE} (
      id           SERIAL PRIMARY KEY,
      name         VARCHAR(50) UNIQUE,
      approved     BOOLEAN DEFAULT false,
      approved_by  TEXT,
      approved_at  TIMESTAMP,
      is_deleted   BOOLEAN DEFAULT false,
      deleted_by   TEXT,
      deleted_at   TIMESTAMP,
      created_by   TEXT,
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_by   TEXT,
      updated_at   TIMESTAMP
    );
  `);

  // ONE-TIME: INT id → user name. After prod OK, remove this call.
  await migrateTableAuditColumnsToUserNames(dbQuery, T.STICKER_TYPE);
}
