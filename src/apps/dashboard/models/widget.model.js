import dbQuery from "../../../config/db.js";
import { MST_TABLES as T } from "../../../config/dbTables.js";

const WIDGET_TABLE = "mst_widgets";
let widgetsTableReady = false;
let widgetsTableInitPromise = null;

export async function ensureWidgetsTable() {
  if (widgetsTableReady) return;
  if (widgetsTableInitPromise) {
    await widgetsTableInitPromise;
    return;
  }

  widgetsTableInitPromise = (async () => {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS ${WIDGET_TABLE} (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        type VARCHAR(20) NOT NULL CHECK (type IN ('count','sum','table','graph','heading','section')),
        query TEXT NOT NULL,
        chart_config JSONB DEFAULT '{}'::jsonb,
        layout JSONB DEFAULT '{}'::jsonb,
        permission_key VARCHAR(120),
        created_by INTEGER REFERENCES ${T.USERS}(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        is_published BOOLEAN DEFAULT true
      )
    `);

    await dbQuery(
      `ALTER TABLE ${WIDGET_TABLE} ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT true`,
    );
    await dbQuery(`ALTER TABLE ${WIDGET_TABLE} ALTER COLUMN is_published SET DEFAULT true`);
    await dbQuery(`UPDATE ${WIDGET_TABLE} SET is_published = true WHERE is_published = false`);
    await dbQuery(`ALTER TABLE ${WIDGET_TABLE} DROP CONSTRAINT IF EXISTS mst_widgets_type_check`);
    await dbQuery(
      `ALTER TABLE ${WIDGET_TABLE}
        ADD CONSTRAINT mst_widgets_type_check
        CHECK (type IN ('count','sum','table','graph','heading','section'))`,
    );
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_mst_widgets_active ON ${WIDGET_TABLE}(is_active)`);
    await dbQuery(
      `CREATE INDEX IF NOT EXISTS idx_mst_widgets_published ON ${WIDGET_TABLE}(is_published)`,
    );
    await dbQuery(
      `CREATE INDEX IF NOT EXISTS idx_mst_widgets_permission_key ON ${WIDGET_TABLE}(permission_key)`,
    );
    widgetsTableReady = true;
  })();

  try {
    await widgetsTableInitPromise;
    widgetsTableInitPromise = null;
  } catch (error) {
    widgetsTableInitPromise = null;
    throw error;
  }
}

export async function createWidget(payload) {
  const {
    title,
    description = "",
    type,
    query,
    chart_config = {},
    layout = {},
    permission_key = null,
    created_by = null,
    is_active = true,
    is_published = true,
  } = payload;

  const rows = await dbQuery(
    `INSERT INTO ${WIDGET_TABLE}
      (title, description, type, query, chart_config, layout, permission_key, created_by, is_active, is_published)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [title, description, type, query, chart_config, layout, permission_key, created_by, is_active, is_published],
  );
  return rows[0];
}

export async function updateWidget(id, payload) {
  const {
    title,
    description = "",
    type,
    query,
    chart_config = {},
    layout = {},
    permission_key = null,
    is_active = true,
    is_published = true,
  } = payload;

  const rows = await dbQuery(
    `UPDATE ${WIDGET_TABLE}
        SET title = $1,
            description = $2,
            type = $3,
            query = $4,
            chart_config = $5,
            layout = $6,
            permission_key = $7,
            is_active = $8,
            is_published = $9,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING *`,
    [title, description, type, query, chart_config, layout, permission_key, is_active, is_published, id],
  );
  return rows[0] || null;
}

export async function deleteWidget(id) {
  const rows = await dbQuery(`DELETE FROM ${WIDGET_TABLE} WHERE id = $1 RETURNING id`, [id]);
  return rows[0] || null;
}

export async function listWidgets() {
  return dbQuery(`SELECT * FROM ${WIDGET_TABLE} ORDER BY updated_at DESC, id DESC`);
}

export async function getWidgetById(id) {
  const rows = await dbQuery(`SELECT * FROM ${WIDGET_TABLE} WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] || null;
}

export async function listActiveWidgets() {
  return dbQuery(
    `SELECT * FROM ${WIDGET_TABLE} WHERE is_active = true AND is_published = true ORDER BY id ASC`,
  );
}

export async function publishWidget(id) {
  const rows = await dbQuery(
    `UPDATE ${WIDGET_TABLE}
        SET is_published = true,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

export async function getUserViewableModuleNames(userId) {
  const rows = await dbQuery(
    `SELECT m.name
       FROM ${T.USER_PERMISSIONS} up
       JOIN ${T.MODULES} m ON m.id = up.module_id
      WHERE up.user_id = $1
        AND up.is_deleted = false
        AND m.is_active = true
        AND up.can_view = true`,
    [userId],
  );
  return rows.map((r) => r.name);
}

