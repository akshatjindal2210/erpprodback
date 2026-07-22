/**
 * Schema patch helpers — used in each *.table.js on server start (initDB).
 *
 * To add a new column in that table's *.table.js:
 *   1. Add the column to CREATE TABLE (for new databases)
 *   2. Use patchTableSchema + patchCol (for existing databases)
 *   3. Optionally backfill/fix old data with runIfColumnExists (same file)
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
    `SELECT data_type, udt_name, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );

  if (!Array.isArray(rows) || rows.length === 0) return;

  const current = String(rows[0].udt_name || rows[0].data_type || "").toLowerCase();
  const currentLen = Number(rows[0].character_maximum_length) || 0;

  if (target === "text" && current === "text") return;

  if (target === "text") {
    await query(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE TEXT`);
    return;
  }

  const varcharMatch = target.match(/^varchar\((\d+)\)$/);
  if (varcharMatch) {
    const wantLen = Number(varcharMatch[1]);
    if (current === "varchar" && currentLen >= wantLen) return;
    await query(
      `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE VARCHAR(${wantLen})`,
    );
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

/** Rename column if old exists and new does not (safe for prod restarts). */
export async function renameColumnIfExists(query, tableName, fromName, toName) {
  if (!tableName || !fromName || !toName || fromName === toName) return;
  if (!(await columnExists(query, tableName, fromName))) return;
  if (await columnExists(query, tableName, toName)) return;
  await query(`ALTER TABLE ${tableName} RENAME COLUMN ${fromName} TO ${toName}`);
}

/** Rename table if old exists and new does not (safe for prod restarts). */
export async function renameTableIfExists(query, fromName, toName) {
  if (!fromName || !toName || fromName === toName) return;
  const fromRows = await query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [fromName],
  );
  if (!Array.isArray(fromRows) || fromRows.length === 0) return;
  const toRows = await query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [toName],
  );
  if (Array.isArray(toRows) && toRows.length > 0) return;
  await query(`ALTER TABLE ${fromName} RENAME TO ${toName}`);
}

