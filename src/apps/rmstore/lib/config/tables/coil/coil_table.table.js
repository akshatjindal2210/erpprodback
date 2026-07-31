import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreCoilTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.COIL_TABLE} (
      coil_uid         SERIAL PRIMARY KEY,
      coil_no_uid      VARCHAR(120) NOT NULL,
      mrn_uid          VARCHAR(100) REFERENCES ${T.MRN}(uid),
      mrn_no           INTEGER,
      serial_no        INTEGER,
      heat_no          VARCHAR(100),
      item_dcode       INTEGER,
      item_code        VARCHAR(100),
      item_desc        TEXT,
      acc_code         INTEGER,
      acc_name         TEXT,
      qty              NUMERIC,
      coil_index       INTEGER,
      total_coils      INTEGER,
      remarks          TEXT,
      location_id      INTEGER REFERENCES ${T.MASTER_LOCATION}(location_id),
      in_uid           INTEGER,
      qc_reject_uid    INTEGER,
      qc_check_uid     INTEGER,
      qc_check_status  VARCHAR(24),
      out_uid          INTEGER,
      sa_id            INTEGER,
      sa_entry_type    VARCHAR(16),
      ipr_uid          INTEGER,
      status           VARCHAR(24) DEFAULT 'active',
      download_count   INTEGER DEFAULT 0,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS rmstore_coil_no_uid_unique_active
      ON ${T.COIL_TABLE} (coil_no_uid)
      WHERE is_deleted = false;

    CREATE INDEX IF NOT EXISTS rmstore_coil_mrn_uid_idx ON ${T.COIL_TABLE}(mrn_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_heat_no_idx ON ${T.COIL_TABLE}(mrn_uid, heat_no);
    CREATE INDEX IF NOT EXISTS rmstore_coil_location_id_idx ON ${T.COIL_TABLE}(location_id);
    CREATE INDEX IF NOT EXISTS rmstore_coil_in_uid_idx ON ${T.COIL_TABLE}(in_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_qc_reject_uid_idx ON ${T.COIL_TABLE}(qc_reject_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_qc_check_uid_idx ON ${T.COIL_TABLE}(qc_check_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_qc_check_status_idx ON ${T.COIL_TABLE}(qc_check_status);
    CREATE INDEX IF NOT EXISTS rmstore_coil_out_uid_idx ON ${T.COIL_TABLE}(out_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_status_idx ON ${T.COIL_TABLE}(status);
    CREATE INDEX IF NOT EXISTS rmstore_coil_area_idx ON ${T.COIL_TABLE}(is_deleted, location_id) WHERE is_deleted = false AND location_id IS NULL;
    CREATE INDEX IF NOT EXISTS rmstore_coil_sa_id_idx ON ${T.COIL_TABLE}(sa_id) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_coil_ipr_uid_idx ON ${T.COIL_TABLE}(ipr_uid) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_coil_created_at_idx ON ${T.COIL_TABLE}(created_at DESC) WHERE is_deleted = false;
  `);
}
