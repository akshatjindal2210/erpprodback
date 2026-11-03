import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** prod_plan_manpower — drop & recreate manually if needed. Hours live from shift. */
export async function createProdPlanManpowerTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.PLAN_MANPOWER} (
      id         SERIAL PRIMARY KEY,
      maccode    INTEGER NOT NULL,
      plan_date  DATE NOT NULL,
      shift_no   SMALLINT NOT NULL,
      emp_code   VARCHAR(200) NOT NULL,
      emp_name   VARCHAR(400),
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_by TEXT,
      updated_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS prod_plan_manpower_cell_idx
      ON ${T.PLAN_MANPOWER} (maccode, plan_date, shift_no);
    CREATE INDEX IF NOT EXISTS prod_plan_manpower_date_idx
      ON ${T.PLAN_MANPOWER} (plan_date);
  `);
}
