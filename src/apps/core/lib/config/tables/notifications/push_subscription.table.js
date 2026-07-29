import dbQuery from "../../../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../../../config/db/dbTables.js";

export async function createPushSubscriptionTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${M.PUSH_SUBSCRIPTIONS} (
      subscription_id SERIAL PRIMARY KEY,
      device_id       VARCHAR(64) NOT NULL,
      user_id         INT NULL REFERENCES ${M.USERS}(id) ON DELETE SET NULL,
      user_name       VARCHAR(255),
      device_name     VARCHAR(255),
      endpoint        TEXT NOT NULL UNIQUE,
      p256dh          TEXT NOT NULL,
      auth            TEXT NOT NULL,
      user_agent      TEXT,
      linked_at       TIMESTAMP NULL,
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at    TIMESTAMP NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mst_push_sub_device
      ON ${M.PUSH_SUBSCRIPTIONS} (device_id);

    CREATE INDEX IF NOT EXISTS idx_mst_push_sub_user
      ON ${M.PUSH_SUBSCRIPTIONS} (user_id)
      WHERE user_id IS NOT NULL;
  `);

  await dbQuery(`
    ALTER TABLE ${M.PUSH_SUBSCRIPTIONS} ADD COLUMN IF NOT EXISTS user_name VARCHAR(255);
    ALTER TABLE ${M.PUSH_SUBSCRIPTIONS} ADD COLUMN IF NOT EXISTS device_name VARCHAR(255);
    ALTER TABLE ${M.PUSH_SUBSCRIPTIONS} ADD COLUMN IF NOT EXISTS linked_at TIMESTAMP NULL;
  `);
}
