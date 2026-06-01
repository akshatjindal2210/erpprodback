import dbQuery from "../../../config/db.js";

/**
 * Keeps PostgreSQL SERIAL sequences aligned with MAX(id) on task_* tables.
 * Prevents duplicate-key errors after data import / restore with explicit IDs.
 */
export async function syncTaskSequences() {
  const rows = await dbQuery(`
    SELECT
      c.relname AS table_name,
      a.attname AS column_name,
      pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relname LIKE 'task_%'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  `);

  for (const { table_name, column_name, seq_name } of rows) {
    try {
      const maxRows = await dbQuery(
        `SELECT COALESCE(MAX(${column_name}), 0)::bigint AS max_val FROM ${table_name}`
      );
      const maxN = Number(maxRows[0]?.max_val) || 0;
      await dbQuery(`SELECT setval($1, GREATEST($2, 1), $3)`, [seq_name, maxN, maxN > 0]);
    } catch (err) {
      console.warn(`⚠️ Failed to sync sequence for ${table_name}.${column_name}:`, err.message);
    }
  }
}
