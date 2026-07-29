import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreLocationMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MASTER_LOCATION} (
      location_id          SERIAL PRIMARY KEY,
      location_no          VARCHAR(100),
      rack_no              VARCHAR(50),
      row_no               VARCHAR(50),
      location_description TEXT,
      total_capacity       INTEGER,
      item_dcode           INTEGER,
      item_code            VARCHAR(100),
      item_desc            TEXT,
      approved             BOOLEAN DEFAULT false,
      approved_by          TEXT,
      approved_at          TIMESTAMP,
      is_deleted           BOOLEAN DEFAULT false,
      deleted_by           TEXT,
      deleted_at           TIMESTAMP,
      created_by           TEXT,
      created_at           TIMESTAMP DEFAULT NOW(),
      updated_by           TEXT,
      updated_at           TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS rmstore_master_location_rack_row_unique_active
      ON ${T.MASTER_LOCATION} (trim(rack_no), UPPER(trim(COALESCE(row_no, ''))))
      WHERE is_deleted = false;

    CREATE UNIQUE INDEX IF NOT EXISTS rmstore_master_location_location_no_unique_active
      ON ${T.MASTER_LOCATION} (trim(location_no))
      WHERE is_deleted = false AND location_no IS NOT NULL AND trim(location_no) <> '';
  `);
}
