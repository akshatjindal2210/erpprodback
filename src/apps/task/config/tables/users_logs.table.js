import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskUsersLogsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.USERS_LOGS} (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES ${C.USERS}(id),
      action_type  VARCHAR(100) NOT NULL,
      module       VARCHAR(100),
      description  TEXT,
      user_type    VARCHAR(50),
      log_data     JSONB,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
