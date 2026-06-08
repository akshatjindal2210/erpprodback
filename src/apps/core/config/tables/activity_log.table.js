import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";

export const createActivityLogsTable = async () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${T.ACTIVITY_LOGS} (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES ${T.USERS}(id) ON DELETE SET NULL,
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
};
