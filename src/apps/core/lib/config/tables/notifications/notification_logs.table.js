import dbQuery from "../../../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../../../config/db/dbTables.js";

/** One row per recipient per channel for every template-driven notification. */
export async function createNotificationLogsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${M.NOTIFICATION_LOGS} (
      id                 BIGSERIAL PRIMARY KEY,
      template_id        INTEGER NULL REFERENCES ${M.NOTIFICATION_TEMPLATES}(id) ON DELETE SET NULL,
      module_id          INTEGER NULL REFERENCES ${M.MODULES}(id) ON DELETE SET NULL,
      record_id          VARCHAR(100),
      action             VARCHAR(20) NOT NULL,
      recipient_user_id  INTEGER NULL REFERENCES ${M.USERS}(id) ON DELETE SET NULL,
      channel            VARCHAR(20) NOT NULL,
      recipient          VARCHAR(255),
      title              TEXT,
      message            TEXT,
      status             VARCHAR(20) NOT NULL,
      error_detail       TEXT,
      inbox_id           INTEGER NULL,
      triggered_by       TEXT,
      sent_at            TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mst_notification_logs_sent
      ON ${M.NOTIFICATION_LOGS} (sent_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mst_notification_logs_template
      ON ${M.NOTIFICATION_LOGS} (template_id, sent_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mst_notification_logs_module
      ON ${M.NOTIFICATION_LOGS} (module_id, sent_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mst_notification_logs_recipient
      ON ${M.NOTIFICATION_LOGS} (recipient_user_id, sent_at DESC);
  `);
}
