import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";
import {
  columnExists,
  dropColumnIfExists,
  patchCol,
  patchTableSchema,
  renameColumnIfExists,
} from "../../../../../../config/db/ensureDbColumns.js";

const LEGACY_B_TYPE = ["material", "material_type", "subtype", "variant", "kind", "class"];

export async function createTrayBatchTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TRAY_BATCH} (
      id            SERIAL PRIMARY KEY,
      batch_id      VARCHAR(100) NOT NULL UNIQUE,
      b_type        VARCHAR(50),
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

  for (const from of LEGACY_B_TYPE) {
    await renameColumnIfExists(dbQuery, T.TRAY_BATCH, from, "b_type");
  }
  for (const from of LEGACY_B_TYPE) {
    await dropColumnIfExists(dbQuery, T.TRAY_BATCH, from);
  }

  await patchTableSchema(dbQuery, T.TRAY_BATCH, {
    columns: [patchCol("b_type", "VARCHAR(50)")],
  });

  await dbQuery(`DROP INDEX IF EXISTS tray_batch_owner_app_idx`);
  await dropColumnIfExists(dbQuery, T.TRAY_BATCH, "owner_app");
  await dropColumnIfExists(dbQuery, T.TRAY_BATCH, "category");
}
