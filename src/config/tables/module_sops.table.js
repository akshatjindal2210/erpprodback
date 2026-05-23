import dbQuery from "../db.js";

export const createModuleSopsTable = async () => {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS module_sops (
      id               SERIAL PRIMARY KEY,
      module_id        INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      permission_type  VARCHAR(20) NOT NULL CHECK (permission_type IN ('view', 'add', 'edit', 'delete', 'authorize')),
      description      TEXT,
      is_required      BOOLEAN NOT NULL DEFAULT false,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       INTEGER REFERENCES users(id),
      deleted_at       TIMESTAMP,
      created_by       INTEGER REFERENCES users(id),
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       INTEGER REFERENCES users(id),
      updated_at       TIMESTAMP
    );
  `);
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS module_sops_module_perm_live_unique
    ON module_sops (module_id, permission_type)
    WHERE is_deleted = false;
  `);
};
