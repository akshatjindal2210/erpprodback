/** prod_jc — drop schedule_shift (shift lives on prod_plan / calendar only). */
import dbQuery from "../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../config/db/dbTables.js";
import { dropColumnIfExists, dropIndexesIfExist } from "../../config/db/ensureDbColumns.js";

export default async function up() {
  await dropIndexesIfExist(dbQuery, ["prod_jc_jobcarddt_shift_idx"]);
  await dropColumnIfExists(dbQuery, T.JC, "schedule_shift");
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS prod_jc_jobcarddt_idx ON ${T.JC} (jobcarddt) WHERE is_deleted = false`
  );
}
