import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreOutEntryScannedCoilTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.OUT_ENTRY_SCANNED_COIL} (
      out_uid      INTEGER NOT NULL REFERENCES ${T.OUT_ENTRY}(out_uid) ON DELETE CASCADE,
      coil_no_uid  TEXT NOT NULL,
      created_at   TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (out_uid, coil_no_uid)
    );

    CREATE INDEX IF NOT EXISTS rmstore_out_entry_scanned_coil_coil_idx
      ON ${T.OUT_ENTRY_SCANNED_COIL} (coil_no_uid);
  `);
}
