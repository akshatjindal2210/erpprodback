import dbQuery from "../db.js";

export async function createAppConfigTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS app_config (
      config_key   VARCHAR(120) PRIMARY KEY,
      config_value TEXT NOT NULL,
      updated_at   TIMESTAMP DEFAULT NOW(),
      updated_by   INTEGER REFERENCES users(id)
    );
  `);
}
