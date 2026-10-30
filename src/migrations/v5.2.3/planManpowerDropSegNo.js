/** prod_plan_manpower — drop seg_no; row id + (mac, date, shift) is enough. */
import dbQuery from "../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../config/db/dbTables.js";
import { dropColumnIfExists, dropIndexesIfExist } from "../../config/db/ensureDbColumns.js";

export default async function up() {
  await dropIndexesIfExist(dbQuery, ["prod_plan_manpower_uq"]);
  await dropColumnIfExists(dbQuery, T.PLAN_MANPOWER, "seg_no");
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS prod_plan_manpower_cell_idx
     ON ${T.PLAN_MANPOWER} (maccode, plan_date, shift_no)`
  );
}
