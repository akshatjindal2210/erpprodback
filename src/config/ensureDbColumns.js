/**
 * Schema patch helpers — used in each *.table.js on server start (initDB).
 *
 * Naya column → usi table ki *.table.js mein:
 *   1. CREATE TABLE mein column likho (naya DB)
 *   2. patchTableSchema + patchCol (purana DB)
 *   3. purana data fix → runIfColumnExists (optional, same file)
 *
 * Example: audit.table.js, box_table.table.js
 */

export async function columnExists(query, tableName, columnName) {
  if (!tableName || !columnName) return false;
  const rows = await query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** Shorthand — patchCol("qty", "INTEGER") → { name, addSql } */
export function patchCol(name, definition) {
  return { name, addSql: `${name} ${definition}` };
}

export async function ensureColumns(query, tableName, columns = []) {
  for (const col of columns) {
    const name = col?.name;
    const addSql = col?.addSql;
    if (!name || !addSql) continue;
    if (await columnExists(query, tableName, name)) continue;
    await query(`ALTER TABLE ${tableName} ADD COLUMN ${addSql}`);
  }
}

export async function ensureIndexes(query, indexes = []) {
  for (const sql of indexes) {
    if (!sql) continue;
    await query(sql);
  }
}

export async function ensureColumnType(query, tableName, columnName, targetType) {
  const target = String(targetType || "").toLowerCase().trim();
  if (!tableName || !columnName || !target) return;

  const rows = await query(
    `SELECT data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );

  if (!Array.isArray(rows) || rows.length === 0) return;

  const current = String(rows[0].udt_name || rows[0].data_type || "").toLowerCase();
  if (target === "text" && current === "text") return;

  if (target === "text") {
    await query(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE TEXT`);
  }
}

export async function ensureColumnNullable(query, tableName, columnName) {
  if (!tableName || !columnName) return;

  const rows = await query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );

  if (!Array.isArray(rows) || rows.length === 0 || rows[0].is_nullable === "YES") return;

  await query(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP NOT NULL`);
}

export async function patchTableSchema(
  query,
  tableName,
  { columns = [], columnTypes = [], nullable = [], indexes = [] } = {}
) {
  await ensureColumns(query, tableName, columns);

  for (const col of columnTypes) {
    if (col?.name && col?.type) {
      await ensureColumnType(query, tableName, col.name, col.type);
    }
  }

  for (const colName of nullable) {
    await ensureColumnNullable(query, tableName, colName);
  }

  await ensureIndexes(query, indexes);
}

export async function runIfColumnExists(query, tableName, columnName, fn) {
  if (!(await columnExists(query, tableName, columnName))) return;
  await fn();
}

export async function dropColumnIfExists(query, tableName, columnName) {
  if (!tableName || !columnName) return;
  if (!(await columnExists(query, tableName, columnName))) return;
  await query(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
}
