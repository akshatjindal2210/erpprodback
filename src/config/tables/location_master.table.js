import dbQuery from "../db.js";

export async function createLocationMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS location_master (
      location_id         SERIAL PRIMARY KEY,
      location_no         VARCHAR(100),
      rack_no             VARCHAR(50),
      shelf_no            VARCHAR(50),
      location_description TEXT,
      total_capacity      INTEGER,
      acc_code            INTEGER,
      item_dcode          INTEGER,
      approved            BOOLEAN DEFAULT false,
      approved_by         INTEGER REFERENCES users(id),
      approved_at         TIMESTAMP,
      is_deleted          BOOLEAN DEFAULT false,
      deleted_by          INTEGER REFERENCES users(id),
      deleted_at          TIMESTAMP,
      created_by          INTEGER REFERENCES users(id),
      created_at          TIMESTAMP DEFAULT NOW(),
      updated_by          INTEGER REFERENCES users(id),
      updated_at          TIMESTAMP
    );
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS location_master_rack_shelf_unique_active
      ON location_master (trim(rack_no), UPPER(trim(COALESCE(shelf_no, ''))))
      WHERE is_deleted = false;
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS location_master_location_no_unique_active
      ON location_master (trim(location_no))
      WHERE is_deleted = false AND location_no IS NOT NULL AND trim(location_no) <> '';
  `);
}