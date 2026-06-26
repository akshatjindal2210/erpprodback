import dbQuery from "../../../../config/db.js";
import { patchTableSchema, patchCol } from "../../../../config/ensureDbColumns.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";

export const createActivityLogsTable = async () => {
  await dbQuery(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  const sql = `
    CREATE TABLE IF NOT EXISTS ${T.ACTIVITY_LOGS} (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES ${T.USERS}(id) ON DELETE SET NULL,
      user_name VARCHAR(100),
      app_type VARCHAR(50) NOT NULL, -- 'portal', 'ims', 'task', etc.
      module VARCHAR(100),           -- 'inventory', 'auth', 'task_management', etc.
      action_type VARCHAR(50),       -- 'CREATE', 'UPDATE', 'DELETE', 'LOGIN', etc.
      description TEXT,
      log_data JSONB,                -- Store payload or metadata
      ip_address VARCHAR(45),
      user_agent TEXT,
      entity VARCHAR(100),           -- For legacy IMS compatibility
      entity_id INTEGER,             -- For legacy IMS compatibility
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON ${T.ACTIVITY_LOGS}(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_app_type ON ${T.ACTIVITY_LOGS}(app_type);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON ${T.ACTIVITY_LOGS}(created_at);
  `;
  await dbQuery(sql);

  await patchTableSchema(dbQuery, T.ACTIVITY_LOGS, {
    columns: [
      patchCol("user_name", "VARCHAR(100)"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_module ON ${T.ACTIVITY_LOGS}(module)`,
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_action_type ON ${T.ACTIVITY_LOGS}(action_type)`,
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON ${T.ACTIVITY_LOGS}(entity, entity_id)`,
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_search_trgm ON ${T.ACTIVITY_LOGS} USING gin (description gin_trgm_ops, module gin_trgm_ops, user_name gin_trgm_ops)`,
    ],
  });

  // Backfill user_name
  await dbQuery(`
    UPDATE ${T.ACTIVITY_LOGS} l
    SET user_name = u.name
    FROM ${T.USERS} u
    WHERE l.user_id = u.id AND l.user_name IS NULL
  `);
};
