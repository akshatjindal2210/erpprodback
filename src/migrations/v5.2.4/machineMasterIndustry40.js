/** eng_machine_master — industry_4_0 flag. Idempotent; no backfill (NOT NULL + default). */
import dbQuery from "../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../config/db/dbTables.js";
import { ensureColumns } from "../../config/db/ensureDbColumns.js";

export default async function up() {
  await ensureColumns(dbQuery, T.MACHINE_MASTER, [
    { name: "industry_4_0", addSql: "industry_4_0 BOOLEAN NOT NULL DEFAULT false" },
  ]);
}
