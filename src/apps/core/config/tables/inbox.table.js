import dbQuery from "../../../../config/db.js";
import { MST_TABLES as M } from "../../../../config/dbTables.js";

export async function createInboxTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${M.INBOX} (
      inbox_id    SERIAL PRIMARY KEY,
      user_id     INT NOT NULL REFERENCES ${M.USERS}(id) ON DELETE CASCADE,
      app_type    VARCHAR(30) NOT NULL DEFAULT 'task',
      task_id     INT NULL,
      trigger_key VARCHAR(50) NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT,
      link_url    TEXT,
      is_read     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_mst_inbox_user_unread
      ON ${M.INBOX} (user_id, is_read, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mst_inbox_user_app
      ON ${M.INBOX} (user_id, app_type, is_read, created_at DESC);
  `);
}
