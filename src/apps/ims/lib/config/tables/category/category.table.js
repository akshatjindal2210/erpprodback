import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createCategoryTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.CATEGORY} (
      id           SERIAL PRIMARY KEY,
      name         VARCHAR(50) UNIQUE,
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
