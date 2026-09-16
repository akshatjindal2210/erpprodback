import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createTrayBatchTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TRAY_BATCH} (
      id            SERIAL PRIMARY KEY,
      batch_id      VARCHAR(100) NOT NULL UNIQUE,
      remark        TEXT,
      approved      BOOLEAN DEFAULT false,
      approved_by   TEXT,
      approved_at   TIMESTAMP,
      is_deleted    BOOLEAN DEFAULT false,
      deleted_by    TEXT,
      deleted_at    TIMESTAMP,
      created_by    TEXT,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_by    TEXT,
      updated_at    TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS tray_batch_created_at_idx ON ${T.TRAY_BATCH} (created_at DESC);
    CREATE INDEX IF NOT EXISTS tray_batch_approved_idx ON ${T.TRAY_BATCH} (approved);
  `);
}
