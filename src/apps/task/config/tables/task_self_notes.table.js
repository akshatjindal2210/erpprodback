import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskSelfNotesTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.SELF_NOTES} (
      self_note_id SERIAL PRIMARY KEY,
      task_id      INT NOT NULL REFERENCES ${T.TASKS}(task_id) ON DELETE CASCADE,
      user_id      INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      note         TEXT NULL,
      attachments  JSONB DEFAULT NULL,
      reminder_at  TIMESTAMP NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (task_id, user_id)
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tsn_task_id ON ${T.SELF_NOTES} (task_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tsn_user_id ON ${T.SELF_NOTES} (user_id)`);
}
