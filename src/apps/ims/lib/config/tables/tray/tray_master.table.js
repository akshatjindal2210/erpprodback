import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createTrayMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TRAY_MASTER} (
      id             SERIAL PRIMARY KEY,
      code           VARCHAR(100) NOT NULL UNIQUE,
      type           VARCHAR(20) NOT NULL,
      serial_number  INTEGER NOT NULL,
      batch_id       VARCHAR(100) NOT NULL,
      status         VARCHAR(20) NOT NULL DEFAULT 'active',
      box_uid        INTEGER REFERENCES ${T.BOX_TABLE}(box_uid) ON DELETE SET NULL,
      updated_by     TEXT,
      updated_at     TIMESTAMP DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS tray_master_type_serial_unique ON ${T.TRAY_MASTER} (type, serial_number);
    CREATE INDEX IF NOT EXISTS tray_master_batch_idx ON ${T.TRAY_MASTER} (batch_id);
    CREATE INDEX IF NOT EXISTS tray_master_status_idx ON ${T.TRAY_MASTER} (status);
    CREATE INDEX IF NOT EXISTS idx_tray_master_box_uid ON ${T.TRAY_MASTER}(box_uid) WHERE box_uid IS NOT NULL;
  `);
}
