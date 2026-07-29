import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreQcRejectionTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.QC_REJECTION} (
      qc_reject_uid    SERIAL PRIMARY KEY,
      out_uid          INTEGER,
      mrn_refs         TEXT,
      heat_nos         TEXT,
      item_codes       TEXT,
      qtys             TEXT,
      total_qty        NUMERIC DEFAULT 0,
      coil_count       INTEGER DEFAULT 0,
      reason           TEXT,
      remarks          TEXT,
      bill_no          TEXT,
      approved         BOOLEAN DEFAULT false,
      approved_by      TEXT,
      approved_at      TIMESTAMP,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rmstore_qc_rejection_created_at_idx
      ON ${T.QC_REJECTION}(created_at DESC);
    CREATE INDEX IF NOT EXISTS rmstore_qc_rejection_out_uid_idx
      ON ${T.QC_REJECTION}(out_uid) WHERE is_deleted = false;
  `);
}
