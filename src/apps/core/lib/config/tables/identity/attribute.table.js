import dbQuery from "../../../../../../config/db/db.js";
import { MST_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createAttributesTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ATTRIBUTES} (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      is_deleted BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Case-insensitive and spans soft-deleted rows: re-adding a deleted name revives the same id.
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${T.ATTRIBUTES}_name_lower_unique
      ON ${T.ATTRIBUTES} (LOWER(name));
  `);
}
