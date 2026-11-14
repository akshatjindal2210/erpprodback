import dbQuery from "../../../../../../config/db/db.js";
import { MST_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";

export async function createAttributesTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ATTRIBUTES} (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_deleted  BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Case-insensitive and spans soft-deleted rows: re-adding a deleted name revives the same id.
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${T.ATTRIBUTES}_name_lower_unique
      ON ${T.ATTRIBUTES} (LOWER(name));
  `);

  await patchTableSchema(dbQuery, T.ATTRIBUTES, {
    columns: [patchCol("permissions", "JSONB NOT NULL DEFAULT '[]'::jsonb")],
  });
}
