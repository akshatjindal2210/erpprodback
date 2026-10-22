import { createJobCardTable } from "../tables/job-card/job_card.table.js";

/** Schema only — Production app tables (entry shortage lives in shared ims_shortage). */
export async function initProductionDB() {
  await createJobCardTable();
}
