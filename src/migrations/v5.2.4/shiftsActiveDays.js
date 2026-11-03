/** mst_shifts — active_days (Mon=1 … Sun=7). Idempotent; no backfill (NOT NULL + default). */
import dbQuery from "../../config/db/db.js";
import { MST_TABLES as T } from "../../config/db/dbTables.js";
import { patchCol, patchTableSchema } from "../../config/db/ensureDbColumns.js";

export default async function up() {
  await patchTableSchema(dbQuery, T.SHIFTS, {
    columns: [patchCol("active_days", "SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}'")],
  });
}
