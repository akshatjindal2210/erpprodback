import dbQuery from "../../config/db/db.js";
import { MST_TABLES as T } from "../../config/db/dbTables.js";
import { columnExists, renameColumnIfExists } from "../../config/db/ensureDbColumns.js";

export default async function shiftNameToCode() {
  const table = T.SHIFTS;
  await renameColumnIfExists(dbQuery, table, "name", "code");

  if (await columnExists(dbQuery, table, "code")) {
    await dbQuery(`DROP INDEX IF EXISTS mst_shifts_name_lower_unique`);
    await dbQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS mst_shifts_code_lower_unique
      ON ${table} (LOWER(TRIM(code)))
    `);
  }
}
