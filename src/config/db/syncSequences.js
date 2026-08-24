import dbQuery from "./db.js";

/**
 * Align PostgreSQL SERIAL / identity sequences with MAX(column).
 * Needed after COPY / INSERT with explicit IDs, table splits, or restores.
 *
 * @param {{ tableLike?: string }} [options]
 *        tableLike — optional pg_class.relname pattern, e.g. "rmstore_%".
 *        Omit to sync every serial column in public.
 */
export async function syncSerialSequences({ tableLike } = {}) {
  const values = [];
  let nameFilter = "";
  if (tableLike) {
    values.push(tableLike);
    nameFilter = "AND c.relname LIKE $1";
  }

  const rows = await dbQuery(
    `
    SELECT
      c.relname AS table_name,
      a.attname AS column_name,
      pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
      ${nameFilter}
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
    `,
    values,
  );

  for (const { table_name, column_name, seq_name } of rows) {
    try {
      const maxRows = await dbQuery(
        `SELECT COALESCE(MAX(${column_name}), 0)::bigint AS max_val FROM ${table_name}`,
      );
      const maxN = Number(maxRows[0]?.max_val) || 0;
      await dbQuery(`SELECT setval($1, GREATEST($2, 1), $3)`, [seq_name, maxN, maxN > 0]);
    } catch (err) {
      console.warn(`⚠️ Failed to sync sequence for ${table_name}.${column_name}:`, err.message);
    }
  }
}
