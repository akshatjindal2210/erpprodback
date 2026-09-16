import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createTrayManageTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TRAY_MANAGE} (
      id           SERIAL PRIMARY KEY,
      data         JSONB NOT NULL,
      approved     BOOLEAN NOT NULL DEFAULT true,
      approved_by  TEXT,
      approved_at  TIMESTAMP,
      created_by   TEXT,
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_by   TEXT,
      updated_at   TIMESTAMP,
      is_deleted   BOOLEAN NOT NULL DEFAULT false,
      deleted_by   TEXT,
      deleted_at   TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS tray_manage_packing_uidx ON ${T.TRAY_MANAGE} ((data->>'packing_number')) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS tray_manage_created_at_idx ON ${T.TRAY_MANAGE} (created_at DESC);
  `);
}
