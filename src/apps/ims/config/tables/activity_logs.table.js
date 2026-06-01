import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createActivityLogsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ACTIVITY_LOGS} (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      user_type    VARCHAR(20) NOT NULL CHECK (user_type IN ('super_admin', 'admin', 'user', 'executive_assistant')),
      action       VARCHAR(50) NOT NULL CHECK (action IN ('login', 'logout', 'create', 'update', 'delete', 'view', 'permission_change')),
      entity       VARCHAR(50) NOT NULL,
      entity_id    INTEGER,
      details      JSONB,
      ip_address   VARCHAR(50),
      user_agent   TEXT,
      approved     BOOLEAN DEFAULT false,
      approved_by  INTEGER REFERENCES ${C.USERS}(id),
      approved_at  TIMESTAMP,
      is_deleted   BOOLEAN DEFAULT false,
      deleted_by   INTEGER REFERENCES ${C.USERS}(id),
      deleted_at   TIMESTAMP,
      created_by   INTEGER REFERENCES ${C.USERS}(id),
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_by   INTEGER REFERENCES ${C.USERS}(id),
      updated_at   TIMESTAMP
    );
  `);
}
