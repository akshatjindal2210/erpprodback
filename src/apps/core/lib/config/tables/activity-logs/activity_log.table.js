import dbQuery from "../../../../../../config/db/db.js";
import { patchTableSchema, patchCol, ensureColumnType } from "../../../../../../config/db/ensureDbColumns.js";
import { MST_TABLES as T } from "../../../../../../config/db/dbTables.js";

export const createActivityLogsTable = async () => {
  await dbQuery(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  const sql = `
    CREATE TABLE IF NOT EXISTS ${T.ACTIVITY_LOGS} (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES ${T.USERS}(id) ON DELETE SET NULL,
      user_name VARCHAR(100),
      app_type VARCHAR(50) NOT NULL, -- 'portal', 'ims', 'task', etc.
      module VARCHAR(100),           -- 'inventory', 'auth', 'task_management', etc.
      action_type VARCHAR(50),       -- 'CREATE', 'UPDATE', 'DELETE', 'LOGIN', etc.
      description TEXT,
      log_data JSONB,                -- Store payload or metadata
      ip_address VARCHAR(45),
      user_agent TEXT,
      entity VARCHAR(100),           -- For legacy IMS compatibility
      entity_id VARCHAR(120),        -- Numeric id or string ref (e.g. MRN uid 3701_2)
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON ${T.ACTIVITY_LOGS}(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_app_type ON ${T.ACTIVITY_LOGS}(app_type);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON ${T.ACTIVITY_LOGS}(created_at);
  `;
  await dbQuery(sql);

  // Existing DBs may still have INTEGER entity_id — widen so string refs (MRN uid) persist
  try {
    const cols = await dbQuery(
      `SELECT data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'entity_id'
       LIMIT 1`,
      [T.ACTIVITY_LOGS]
    );
    const dt = String(cols[0]?.data_type || cols[0]?.udt_name || "").toLowerCase();
    if (dt === "integer" || dt === "int4" || dt === "bigint" || dt === "int8") {
      await dbQuery(
        `ALTER TABLE ${T.ACTIVITY_LOGS}
         ALTER COLUMN entity_id TYPE VARCHAR(120) USING entity_id::text`
      );
    } else {
      await ensureColumnType(dbQuery, T.ACTIVITY_LOGS, "entity_id", "varchar(120)");
    }
  } catch (err) {
    console.error("[activity_logs] entity_id type patch failed:", err.message);
  }

  // Backfill REF from log_data.ref when column was previously null (non-numeric ids).
  // Avoid JSONB `?` operator — dbQuery converts `?` to $n placeholders.
  try {
    await dbQuery(`
      UPDATE ${T.ACTIVITY_LOGS}
      SET entity_id = NULLIF(TRIM(log_data->>'ref'), '')
      WHERE entity_id IS NULL
        AND NULLIF(TRIM(COALESCE(log_data->>'ref', '')), '') IS NOT NULL
    `);
  } catch (err) {
    console.error("[activity_logs] entity_id backfill failed:", err.message);
  }

  await patchTableSchema(dbQuery, T.ACTIVITY_LOGS, {
    columns: [
      patchCol("user_name", "VARCHAR(100)"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_module ON ${T.ACTIVITY_LOGS}(module)`,
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_action_type ON ${T.ACTIVITY_LOGS}(action_type)`,
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON ${T.ACTIVITY_LOGS}(entity, entity_id)`,
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_search_trgm ON ${T.ACTIVITY_LOGS} USING gin (description gin_trgm_ops, module gin_trgm_ops, user_name gin_trgm_ops)`,
    ],
  });
};
