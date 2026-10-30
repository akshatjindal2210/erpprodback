import { createJobCardTable } from "../tables/jc/jc.table.js";
import { createProdPlanTable } from "../tables/plan/plan.table.js";
import { createProdPlanManpowerTable } from "../tables/plan/planManpower.table.js";

/** Schema only — prod_jc + prod_plan + prod_plan_manpower. */
export async function initProductionDB() {
  await createJobCardTable();
  await createProdPlanTable();
  await createProdPlanManpowerTable();
}
