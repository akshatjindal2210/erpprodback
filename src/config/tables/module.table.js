import dbQuery from "../db.js";

export const createModulesTable = async () => {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS modules (
      id            INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      name          VARCHAR(100) UNIQUE NOT NULL,
      label         VARCHAR(100) NOT NULL,
      sort_order    VARCHAR(20) NOT NULL DEFAULT '0',
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at    TIMESTAMP
    );
  `);

  await dbQuery(`
    ALTER TABLE modules
      ADD COLUMN IF NOT EXISTS sort_order VARCHAR(20) NOT NULL DEFAULT '0';
  `);
};