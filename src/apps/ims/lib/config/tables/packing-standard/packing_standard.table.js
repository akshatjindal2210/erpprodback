import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createPackingStandardTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.PACKING_STANDARD} (
      standard_id  SERIAL PRIMARY KEY,
      item_dcode   INTEGER NOT NULL,
      qty          INTEGER,
      unit         VARCHAR(50),
      type         INTEGER REFERENCES ${T.CATEGORY}(id),
      sticker_type INTEGER REFERENCES ${T.STICKER_TYPE}(id),
      acc_code     INTEGER,
      approved     BOOLEAN DEFAULT false,
      approved_by  TEXT,
      approved_at  TIMESTAMP,
      is_deleted   BOOLEAN DEFAULT false,
      deleted_by   TEXT,
      deleted_at   TIMESTAMP,
      created_by   TEXT,
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_by   TEXT,
      updated_at   TIMESTAMP
    );
  `);
}
