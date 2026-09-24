import dbQuery from "../../../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../../../config/db/dbTables.js";
import { patchTableSchema, patchCol } from "../../../../../../config/db/ensureDbColumns.js";

export async function createNotificationTemplatesTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${M.NOTIFICATION_TEMPLATES} (
      id              SERIAL PRIMARY KEY,
      module_id       INTEGER NOT NULL REFERENCES ${M.MODULES}(id) ON DELETE CASCADE,
      name            VARCHAR(150) NOT NULL,
      subject         TEXT,
      message         TEXT NOT NULL,
      trigger_events  TEXT[] NOT NULL,
      recipient_type  VARCHAR(20),
      recipient_refs  TEXT[] NOT NULL DEFAULT '{}',
      audience        JSONB NOT NULL DEFAULT '{}'::jsonb,
      pwa_enabled     BOOLEAN NOT NULL DEFAULT true,
      email_enabled   BOOLEAN NOT NULL DEFAULT false,
      send_via        VARCHAR(10) NOT NULL DEFAULT 'none',
      is_active       BOOLEAN NOT NULL DEFAULT true,
      is_deleted      BOOLEAN NOT NULL DEFAULT false,
      deleted_by      TEXT,
      deleted_at      TIMESTAMP,
      created_by      TEXT,
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      TEXT,
      updated_at      TIMESTAMP,
      CONSTRAINT notification_templates_events_chk
        CHECK (cardinality(trigger_events) > 0 AND trigger_events <@ ARRAY['add', 'edit', 'delete', 'approve']::TEXT[]),
      CONSTRAINT notification_templates_recipient_type_chk
        CHECK (recipient_type IS NULL OR recipient_type IN ('attribute', 'role', 'department', 'designation', 'user')),
      CONSTRAINT notification_templates_send_via_chk
        CHECK (send_via IN ('none', 'free', 'paid'))
    );

    CREATE INDEX IF NOT EXISTS idx_mst_notification_templates_module_live
      ON ${M.NOTIFICATION_TEMPLATES} (module_id)
      WHERE is_deleted = false AND is_active = true;
  `);

  await patchTableSchema(dbQuery, M.NOTIFICATION_TEMPLATES, {
    columns: [
      patchCol("recipient_refs", "TEXT[] NOT NULL DEFAULT '{}'"),
      patchCol("audience", "JSONB NOT NULL DEFAULT '{}'::jsonb"),
      patchCol("pwa_enabled", "BOOLEAN NOT NULL DEFAULT true"),
      patchCol("email_enabled", "BOOLEAN NOT NULL DEFAULT false"),
    ],
    nullable: ["recipient_type"],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_mst_notification_templates_module_live
        ON ${M.NOTIFICATION_TEMPLATES} (module_id)
        WHERE is_deleted = false AND is_active = true`,
    ],
  });
}
