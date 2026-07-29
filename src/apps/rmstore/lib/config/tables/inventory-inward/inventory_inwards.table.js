import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreInventoryInwardsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.INVENTORY_INWARDS} (
      in_uid           SERIAL PRIMARY KEY,
      mrn_refs         TEXT,
      heat_nos         TEXT,
      item_codes       TEXT,
      qtys             TEXT,
      total_qty        NUMERIC DEFAULT 0,
      coil_count       INTEGER DEFAULT 0,
      remarks          TEXT,
      approved         BOOLEAN DEFAULT false,
      approved_by      TEXT,
      approved_at      TIMESTAMP,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rmstore_inwards_created_at_idx ON ${T.INVENTORY_INWARDS}(created_at DESC);
  `);
}
