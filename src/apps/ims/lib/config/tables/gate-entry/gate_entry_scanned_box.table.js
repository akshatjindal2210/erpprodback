import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createGateEntryScannedBoxTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.GATE_ENTRY_SCANNED_BOX} (
      uid         INTEGER NOT NULL,
      box_no_uid  TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (uid, box_no_uid)
    );

    CREATE INDEX IF NOT EXISTS idx_gate_entry_scanned_box_box
      ON ${T.GATE_ENTRY_SCANNED_BOX} (box_no_uid);
  `);
}
