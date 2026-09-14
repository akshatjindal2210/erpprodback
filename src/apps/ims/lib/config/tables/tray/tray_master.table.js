import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createTrayMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TRAY_MASTER} (
      id                 SERIAL PRIMARY KEY,
      code               VARCHAR(100) NOT NULL UNIQUE,
      type               VARCHAR(20) NOT NULL,
      serial_number      INTEGER NOT NULL,
      batch_id           VARCHAR(100) NOT NULL,
      approved           BOOLEAN DEFAULT false,
      approved_by        TEXT,
      approved_at        TIMESTAMP,
      status             VARCHAR(20) NOT NULL DEFAULT 'active',
      created_by         TEXT,
      created_at         TIMESTAMP DEFAULT NOW(),
      updated_by         TEXT,
      updated_at         TIMESTAMP,
      deleted_by         TEXT,
      deleted_at         TIMESTAMP,
      remark             TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS tray_master_type_serial_unique ON ${T.TRAY_MASTER} (type, serial_number);
    CREATE INDEX IF NOT EXISTS tray_master_type_status_idx ON ${T.TRAY_MASTER} (type, status);
    CREATE INDEX IF NOT EXISTS tray_master_batch_idx ON ${T.TRAY_MASTER} (batch_id);
    CREATE INDEX IF NOT EXISTS tray_master_created_at_idx ON ${T.TRAY_MASTER} (created_at DESC);
  `);
}
