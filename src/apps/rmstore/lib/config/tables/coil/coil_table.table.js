import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as IT, RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { columnExists, dropColumnsIfExist } from "../../../../../../config/db/ensureDbColumns.js";

/**
 * Coil master — only create audit (created_by / created_at).
 * No soft-delete; no updated_by / updated_at. Deletes are permanent.
 */
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
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW()
    );
  `);

  // Existing DBs: purge soft-deleted ghosts, then drop audit columns we no longer keep.
  if (await columnExists(dbQuery, T.COIL_TABLE, "is_deleted")) {
    await dbQuery(`DELETE FROM ${T.COIL_TABLE} WHERE is_deleted = true`);
  }

  await dbQuery(`DROP INDEX IF EXISTS rmstore_coil_no_uid_unique_active`);
  await dbQuery(`DROP INDEX IF EXISTS rmstore_coil_area_idx`);
  await dbQuery(`DROP INDEX IF EXISTS rmstore_coil_sa_id_idx`);
  await dbQuery(`DROP INDEX IF EXISTS rmstore_coil_ipr_uid_idx`);
  await dbQuery(`DROP INDEX IF EXISTS rmstore_coil_created_at_idx`);

  await dropColumnsIfExist(dbQuery, T.COIL_TABLE, [
    "is_deleted",
    "deleted_by",
    "deleted_at",
    "updated_by",
    "updated_at",
  ]);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS rmstore_coil_no_uid_unique
      ON ${T.COIL_TABLE} (coil_no_uid);

    CREATE INDEX IF NOT EXISTS rmstore_coil_mrn_uid_idx ON ${T.COIL_TABLE}(mrn_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_loc_id_idx ON ${T.COIL_TABLE}(location_id);
    CREATE INDEX IF NOT EXISTS rmstore_coil_in_uid_idx ON ${T.COIL_TABLE}(in_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_rm_uid_idx ON ${T.COIL_TABLE}(rm_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_qc_uid_idx ON ${T.COIL_TABLE}(qc_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_out_uid_idx ON ${T.COIL_TABLE}(out_uid);
    CREATE INDEX IF NOT EXISTS rmstore_coil_status_idx ON ${T.COIL_TABLE}(status);
    CREATE INDEX IF NOT EXISTS rmstore_coil_area_idx ON ${T.COIL_TABLE}(location_id) WHERE location_id IS NULL;
    CREATE INDEX IF NOT EXISTS rmstore_coil_sa_id_idx ON ${T.COIL_TABLE}(sa_id) WHERE sa_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS rmstore_coil_ipr_uid_idx ON ${T.COIL_TABLE}(ipr_uid) WHERE ipr_uid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS rmstore_coil_created_at_idx ON ${T.COIL_TABLE}(created_at DESC);

    ALTER TABLE ${T.COIL_TABLE}
      DROP CONSTRAINT IF EXISTS rmstore_coil_table_location_id_fkey;

    ALTER TABLE ${T.COIL_TABLE}
      ADD CONSTRAINT rmstore_coil_table_location_id_fkey
      FOREIGN KEY (location_id)
      REFERENCES ${IT.LOCATION_MASTER}(location_id)
      NOT VALID;
  `);
}
