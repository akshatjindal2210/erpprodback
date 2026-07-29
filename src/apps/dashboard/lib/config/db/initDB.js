import { createDashboardConfigTable } from "../tables/dashboard/dashboardConfig.table.js";

export async function initDashboardDB() {
  await createDashboardConfigTable();
}
