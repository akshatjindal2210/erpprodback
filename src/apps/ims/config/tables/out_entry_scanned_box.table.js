import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createOutEntryScannedBoxTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.OUT_ENTRY_SCANNED_BOX} (
      out_uid     INTEGER NOT NULL REFERENCES ${T.OUT_ENTRY}(out_uid) ON DELETE CASCADE,
      box_no_uid  TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (out_uid, box_no_uid)
    );

    CREATE INDEX IF NOT EXISTS idx_out_entry_scanned_box_box
      ON ${T.OUT_ENTRY_SCANNED_BOX} (box_no_uid);
  `);
}
