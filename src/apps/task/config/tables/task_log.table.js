import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskLogTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.LOG} (
      activity_id   SERIAL PRIMARY KEY,
      task_id       INT NOT NULL REFERENCES ${T.TASKS}(task_id) ON DELETE CASCADE,
      assignment_id INT NULL REFERENCES ${T.ASSIGNMENTS}(assignment_id) ON DELETE SET NULL,
      user_id       INT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      performed_by  VARCHAR(255),
      action        VARCHAR(100) NOT NULL,
      action_detail TEXT,
      action_time   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_task_log_task_id ON ${T.LOG} (task_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_task_log_action_time ON ${T.LOG} (action_time)`);
}
