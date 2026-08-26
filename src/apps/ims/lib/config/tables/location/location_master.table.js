import dbQuery from "../../../../../../config/db/db.js";
import { patchTableSchema, patchCol } from "../../../../../../config/db/ensureDbColumns.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** Structure only — one-shot data moves live in src/migrations/vX.Y.Z/ */
export async function createLocationMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.LOCATION_MASTER} (
      location_id          SERIAL PRIMARY KEY,
      location_no          VARCHAR(100),
      rack_no              VARCHAR(50),
      shelf_no             VARCHAR(50),
      type                 VARCHAR(50) DEFAULT 'ims',
      location_description TEXT,
      total_capacity       INTEGER,
      acc_codes            INTEGER[] DEFAULT '{}',
      item_dcodes          INTEGER[] DEFAULT '{}',
      rule                 VARCHAR(20) DEFAULT 'include',
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
  `);

  await patchTableSchema(dbQuery, T.LOCATION_MASTER, {
    columns: [
      patchCol("type", "VARCHAR(50) DEFAULT 'ims'"),
      patchCol("acc_codes", "INTEGER[] DEFAULT '{}'"),
      patchCol("item_dcodes", "INTEGER[] DEFAULT '{}'"),
      patchCol("rule", "VARCHAR(20) DEFAULT 'include'"),
    ],
  });

  await dbQuery(`
    DROP INDEX IF EXISTS location_master_rack_shelf_unique_active;
    DROP INDEX IF EXISTS location_master_location_no_unique_active;
  `);

  for (const sql of [
    `CREATE UNIQUE INDEX IF NOT EXISTS location_master_rack_shelf_type_unique_active
       ON ${T.LOCATION_MASTER} (trim(rack_no), UPPER(trim(COALESCE(shelf_no, ''))), lower(trim(COALESCE(type, 'ims'))))
       WHERE is_deleted = false`,
    `CREATE UNIQUE INDEX IF NOT EXISTS location_master_location_no_type_unique_active
       ON ${T.LOCATION_MASTER} (trim(location_no), lower(trim(COALESCE(type, 'ims'))))
       WHERE is_deleted = false AND location_no IS NOT NULL AND trim(location_no) <> ''`,
    `CREATE INDEX IF NOT EXISTS location_master_acc_codes_gin ON ${T.LOCATION_MASTER} USING GIN (acc_codes)`,
    `CREATE INDEX IF NOT EXISTS location_master_item_dcodes_gin ON ${T.LOCATION_MASTER} USING GIN (item_dcodes)`,
  ]) {
    try {
      await dbQuery(sql);
    } catch (err) {
      console.warn("[location_master] index skipped:", err.message);
    }
  }
}
