import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as IT, RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreCoilTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.COIL_TABLE} (
      coil_uid         SERIAL PRIMARY KEY,
      coil_no_uid      VARCHAR(120) NOT NULL,
      mrn_uid          VARCHAR(100) REFERENCES ${T.MRN}(uid),
      qty              NUMERIC,
      location_id      INTEGER REFERENCES ${IT.LOCATION_MASTER}(location_id),
      in_uid           INTEGER,
      rm_uid           INTEGER,
      qc_uid           INTEGER,
      out_uid          INTEGER,
      sa_id            INTEGER,
      sa_entry_type    VARCHAR(50),
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
    CREATE INDEX IF NOT EXISTS rmstore_coil_loc_id_idx ON ${T.COIL_TABLE}(location_id);
    CREATE INDEX IF NOT EXISTS rmstore_coil_in_uid_idx ON ${T.COIL_TABLE}(in_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_rm_uid_idx ON ${T.COIL_TABLE}(rm_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_qc_uid_idx ON ${T.COIL_TABLE}(qc_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_out_uid_idx ON ${T.COIL_TABLE}(out_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_status_idx ON ${T.COIL_TABLE}(status);
    CREATE INDEX IF NOT EXISTS rmstore_coil_area_idx ON ${T.COIL_TABLE}(is_deleted, location_id) WHERE is_deleted = false AND location_id IS NULL;
    CREATE INDEX IF NOT EXISTS rmstore_coil_sa_id_idx ON ${T.COIL_TABLE}(sa_id) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_coil_ipr_uid_idx ON ${T.COIL_TABLE}(ipr_uid) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_coil_created_at_idx ON ${T.COIL_TABLE}(created_at DESC) WHERE is_deleted = false;

    ALTER TABLE ${T.COIL_TABLE}
      DROP CONSTRAINT IF EXISTS rmstore_coil_table_location_id_fkey;

    ALTER TABLE ${T.COIL_TABLE}
      ADD CONSTRAINT rmstore_coil_table_location_id_fkey
      FOREIGN KEY (location_id)
      REFERENCES ${IT.LOCATION_MASTER}(location_id)
      NOT VALID;
  `);
}
