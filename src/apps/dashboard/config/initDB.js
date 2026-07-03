import { createDashboardConfigTable } from "./tables/dashboardConfig.table.js";

export async function initDashboardDB() {
  await createDashboardConfigTable();
}
