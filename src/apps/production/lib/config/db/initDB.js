import { createJobCardTable } from "../tables/jc/jc.table.js";
import { createProdPlanTable } from "../tables/plan/plan.table.js";
import { createProdPlanManpowerTable } from "../tables/plan/planManpower.table.js";
import { createProdEntryTable } from "../tables/entry/entry.table.js";

export async function initProductionDB() {
  await createJobCardTable();
  await createProdPlanTable();
  await createProdPlanManpowerTable();
  await createProdEntryTable();
}
