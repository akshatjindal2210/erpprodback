import dbQuery from "../../../../config/db.js";

export const DASHBOARD_CONFIG_TABLE = "mst_dashboard_configs";

export async function createDashboardConfigTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${DASHBOARD_CONFIG_TABLE} (
      id SERIAL PRIMARY KEY,
      dashboard_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(
    `CREATE INDEX IF NOT EXISTS idx_mst_dashboard_configs_json
      ON ${DASHBOARD_CONFIG_TABLE} USING GIN (dashboard_json)`,
  );
}
