import dbQuery from "../../../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../../../config/db/dbTables.js";

export async function createPushDeliveryLogTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${M.PUSH_DELIVERY_LOG} (
      push_log_id     SERIAL PRIMARY KEY,
      tracking_id     UUID NOT NULL UNIQUE,
      user_id         INT NULL REFERENCES ${M.USERS}(id) ON DELETE SET NULL,
      user_name       VARCHAR(255),
      subscription_id INT NULL REFERENCES ${M.PUSH_SUBSCRIPTIONS}(subscription_id) ON DELETE SET NULL,
      device_id       VARCHAR(64),
      device_name     VARCHAR(255),
      inbox_id        INT NULL,
      template_key    VARCHAR(50),
      channel         VARCHAR(30) NOT NULL DEFAULT 'pwa_push',
      app_type        VARCHAR(30) NOT NULL DEFAULT 'task',
      title           TEXT,
      body            TEXT,
      status          VARCHAR(20) NOT NULL DEFAULT 'sent',
      error_detail    TEXT,
      sent_at         TIMESTAMP NULL,
      received_at     TIMESTAMP NULL,
      read_at         TIMESTAMP NULL,
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_mst_push_log_user
      ON ${M.PUSH_DELIVERY_LOG} (user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mst_push_log_status
      ON ${M.PUSH_DELIVERY_LOG} (status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mst_push_log_inbox
      ON ${M.PUSH_DELIVERY_LOG} (inbox_id)
      WHERE inbox_id IS NOT NULL;
  `);

  await dbQuery(`
    ALTER TABLE ${M.PUSH_DELIVERY_LOG} ADD COLUMN IF NOT EXISTS template_key VARCHAR(50);
    ALTER TABLE ${M.PUSH_DELIVERY_LOG} ADD COLUMN IF NOT EXISTS channel VARCHAR(30) NOT NULL DEFAULT 'pwa_push';
    ALTER TABLE ${M.PUSH_DELIVERY_LOG} ADD COLUMN IF NOT EXISTS app_type VARCHAR(30) NOT NULL DEFAULT 'task';
    ALTER TABLE ${M.PUSH_DELIVERY_LOG} ADD COLUMN IF NOT EXISTS received_client_ip VARCHAR(45);
    ALTER TABLE ${M.PUSH_DELIVERY_LOG} ADD COLUMN IF NOT EXISTS received_on_company_network BOOLEAN;
  `);
}
