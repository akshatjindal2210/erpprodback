import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreOutEntryTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.OUT_ENTRY} (
      out_uid          SERIAL PRIMARY KEY,
      entry_type       VARCHAR(40) DEFAULT 'store_out',
      qc_reject_uid    INTEGER,
      mrn_refs         TEXT,
      heat_nos         TEXT,
      item_codes       TEXT,
      qtys             TEXT,
      total_qty        NUMERIC DEFAULT 0,
      coil_count       INTEGER DEFAULT 0,
      location_refs    TEXT,
      remarks          TEXT,
      approved         BOOLEAN DEFAULT false,
      approved_by      TEXT,
      approved_at      TIMESTAMP,
      scan_complete    BOOLEAN DEFAULT false,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rmstore_out_entry_created_at_idx
      ON ${T.OUT_ENTRY}(created_at DESC);
    CREATE INDEX IF NOT EXISTS rmstore_out_entry_entry_type_idx
      ON ${T.OUT_ENTRY}(entry_type) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_out_entry_qc_reject_uid_idx
      ON ${T.OUT_ENTRY}(qc_reject_uid) WHERE is_deleted = false;
  `);
}
