import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreQcCheckTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.QC_CHECK} (
      qc_check_uid     SERIAL PRIMARY KEY,
      coil_no_uid      VARCHAR(120) NOT NULL,
      mrn_uid          VARCHAR(100),
      mrn_no           INTEGER,
      heat_no          VARCHAR(100),
      item_dcode       INTEGER,
      item_code        VARCHAR(100),
      item_desc        TEXT,
      qty              NUMERIC DEFAULT 0,
      status           VARCHAR(24) DEFAULT 'pending',
      failure_reason   TEXT,
      remarks          TEXT,
      items            JSONB NOT NULL DEFAULT '[]'::jsonb,
      inspected_by     TEXT,
      inspected_at     TIMESTAMP,
      approved         BOOLEAN DEFAULT false,
      approved_by      TEXT,
      approved_at      TIMESTAMP,
      qc_reject_uid    INTEGER,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rmstore_qc_check_status_idx
      ON ${T.QC_CHECK}(status) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_qc_check_coil_idx
      ON ${T.QC_CHECK}(coil_no_uid) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_qc_check_mrn_idx
      ON ${T.QC_CHECK}(mrn_uid) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_qc_check_approved_idx
      ON ${T.QC_CHECK}(approved) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_qc_check_qc_reject_uid_idx
      ON ${T.QC_CHECK}(qc_reject_uid) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_qc_check_created_at_idx
      ON ${T.QC_CHECK}(created_at);
  `);
}
