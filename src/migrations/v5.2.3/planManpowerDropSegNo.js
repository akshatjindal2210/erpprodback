/** prod_plan_manpower — drop seg_no (skip if table not created yet; initDB creates table after migrations). */
import dbQuery from "../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../config/db/dbTables.js";
import { dropColumnIfExists, dropIndexesIfExist, tableExists } from "../../config/db/ensureDbColumns.js";

export default async function up() {
  if (!(await tableExists(dbQuery, T.PLAN_MANPOWER))) return;

  await dropIndexesIfExist(dbQuery, ["prod_plan_manpower_uq"]);
  await dropColumnIfExists(dbQuery, T.PLAN_MANPOWER, "seg_no");
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS prod_plan_manpower_cell_idx
     ON ${T.PLAN_MANPOWER} (maccode, plan_date, shift_no)`
  );
}
