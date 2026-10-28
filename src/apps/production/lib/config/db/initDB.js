import { createJobCardTable } from "../tables/jc/jc.table.js";
import { createProdPlanTable } from "../tables/plan/plan.table.js";

/** Schema only — prod_jc + prod_plan (structure in *.table.js). */
export async function initProductionDB() {
  await createJobCardTable();
  await createProdPlanTable();
}
