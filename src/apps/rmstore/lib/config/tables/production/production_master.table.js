import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreProductionMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MASTER_PRODUCTION} (
      production_id   SERIAL PRIMARY KEY,
      item_dcode      INTEGER NOT NULL,
      item_code       VARCHAR(100),
      item_desc       TEXT,
      rm_item_dcode   INTEGER NOT NULL,
      rm_item_code    VARCHAR(100),
      rm_item_desc    TEXT,
      approved        BOOLEAN DEFAULT false,
      approved_by     TEXT,
      approved_at     TIMESTAMP,
      is_deleted      BOOLEAN DEFAULT false,
      deleted_by      TEXT,
      deleted_at      TIMESTAMP,
      created_by      TEXT,
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      TEXT,
      updated_at      TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS rmstore_master_production_item_rm_unique_active
      ON ${T.MASTER_PRODUCTION} (item_dcode, rm_item_dcode)
      WHERE is_deleted = false;
  `);
}
