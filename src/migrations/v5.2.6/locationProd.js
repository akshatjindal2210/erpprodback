/**
 * Location: type `production` → `prod`; drop unused `sub_no`.
 * Prod uniqueness = location_no (AREA_ZONE_NUMBER), not rack+zone alone
 * (NF_A_1 and NT_A_1 share rack/zone but are different areas).
 */
import dbQuery from "../../config/db/db.js";
import { IMS_TABLES as T } from "../../config/db/dbTables.js";
import { columnExists, dropColumnIfExists } from "../../config/db/ensureDbColumns.js";

const TABLE = T.LOCATION_MASTER;

async function ensureProdAwareRackSlotIndex() {
  await dbQuery(`DROP INDEX IF EXISTS location_master_rack_shelf_unique_active`);
  await dbQuery(`DROP INDEX IF EXISTS location_master_rack_shelf_type_unique_active`);
  await dbQuery(`DROP INDEX IF EXISTS location_master_rack_slot_type_unique_active`);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS location_master_rack_slot_type_unique_active
      ON ${TABLE} (
        trim(rack_no),
        UPPER(trim(COALESCE(shelf_no, ''))),
        lower(trim(COALESCE(type, 'ims'))),
        COALESCE(proccode, 0)
      )
      WHERE is_deleted = false
        AND lower(trim(COALESCE(type, 'ims'))) <> 'prod'
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS location_master_location_no_type_unique_active
      ON ${TABLE} (trim(location_no), lower(trim(COALESCE(type, 'ims'))))
      WHERE is_deleted = false
        AND location_no IS NOT NULL
        AND trim(location_no) <> ''
  `);
}

export default async function up() {
  await dbQuery(
    `UPDATE ${TABLE}
     SET type = 'prod'
     WHERE lower(trim(COALESCE(type, ''))) = 'production'`,
  );

  if (await columnExists(dbQuery, TABLE, "sub_no")) {
    await dropColumnIfExists(dbQuery, TABLE, "sub_no");
  }

  await ensureProdAwareRackSlotIndex();

  console.log("[migration] locationProd: production→prod; prod unique by location_no");
}
