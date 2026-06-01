import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskChatTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.CHAT} (
      chat_id     SERIAL PRIMARY KEY,
      task_id     INT NOT NULL REFERENCES ${T.TASKS}(task_id) ON DELETE CASCADE,
      user_id     INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      message     TEXT NULL,
      reply_to_id INT DEFAULT NULL REFERENCES ${T.CHAT}(chat_id) ON DELETE SET NULL,
      attachments JSONB DEFAULT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tc_task_id ON ${T.CHAT} (task_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tc_user_id ON ${T.CHAT} (user_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tc_reply_to ON ${T.CHAT} (reply_to_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tc_created_at ON ${T.CHAT} (created_at)`);
}
