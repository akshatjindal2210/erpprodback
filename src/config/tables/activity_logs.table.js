import dbQuery from "../db.js";

export const createActivityLogsTable = async () => {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_type    VARCHAR(20) CHECK (user_type IN ('super_admin', 'admin', 'user')) NOT NULL,
      action       VARCHAR(50) CHECK (action IN ('login', 'logout', 'create', 'update', 'delete', 'view', 'permission_change')) NOT NULL,
      entity       VARCHAR(50) NOT NULL,
      entity_id    INTEGER,
      details      JSONB,
      ip_address   VARCHAR(50),
      user_agent   TEXT,
      approved     BOOLEAN DEFAULT false,
      approved_by  INTEGER REFERENCES users(id),
      approved_at  TIMESTAMP,
      is_deleted   BOOLEAN DEFAULT false,
      deleted_by   INTEGER REFERENCES users(id),
      deleted_at   TIMESTAMP,
      created_by   INTEGER REFERENCES users(id),
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_by   INTEGER REFERENCES users(id),
      updated_at   TIMESTAMP
    );
  `);
};