import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createLocationMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.LOCATION_MASTER} (
      location_id          SERIAL PRIMARY KEY,
      location_no          VARCHAR(100),
      rack_no              VARCHAR(50),
      shelf_no             VARCHAR(50),
      location_description TEXT,
      total_capacity       INTEGER,
      acc_code             INTEGER,
      item_dcode           INTEGER,
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

    CREATE UNIQUE INDEX IF NOT EXISTS location_master_rack_shelf_unique_active
      ON ${T.LOCATION_MASTER} (trim(rack_no), UPPER(trim(COALESCE(shelf_no, ''))))
      WHERE is_deleted = false;

    CREATE UNIQUE INDEX IF NOT EXISTS location_master_location_no_unique_active
      ON ${T.LOCATION_MASTER} (trim(location_no))
      WHERE is_deleted = false AND location_no IS NOT NULL AND trim(location_no) <> '';
  `);
}
