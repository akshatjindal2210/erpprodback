import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createStickerTypeTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.STICKER_TYPE} (
      id           SERIAL PRIMARY KEY,
      name         VARCHAR(50) UNIQUE,
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
