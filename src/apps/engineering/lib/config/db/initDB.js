import { createProcessMasterTable } from "../tables/process/process_master.table.js";
import { createMachineMasterTable } from "../tables/machine/machine_master.table.js";

/** Schema only — Engineering app tables. */
export async function initEngineeringDB() {
  await createProcessMasterTable();
  await createMachineMasterTable();
}
