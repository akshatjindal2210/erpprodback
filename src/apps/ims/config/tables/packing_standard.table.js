import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

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
      approved_by  INTEGER REFERENCES ${C.USERS}(id),
      approved_at  TIMESTAMP,
      is_deleted   BOOLEAN DEFAULT false,
      deleted_by   INTEGER REFERENCES ${C.USERS}(id),
      deleted_at   TIMESTAMP,
      created_by   INTEGER REFERENCES ${C.USERS}(id),
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_by   INTEGER REFERENCES ${C.USERS}(id),
      updated_at   TIMESTAMP
    );
  `);
}
