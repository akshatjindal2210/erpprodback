/**
 * Schema patch helpers — used in each *.table.js on server start (initDB).
 *
 * New database     → CREATE TABLE IF NOT EXISTS (full structure)
 * Existing database → ensure* calls below add/update only what is missing
 *
 * When you add something new:
 *   1. Put the column in CREATE TABLE (new installs)
 *   2. Add the same column/type in patchTableSchema below (old installs)
 *
 * All helpers are idempotent — already correct → no-op.
 *
 * @example
 * import { patchTableSchema } from "../../../../config/ensureDbColumns.js";
 *
 * export async function createMyTable() {
 *   await dbQuery(`CREATE TABLE IF NOT EXISTS ${T.MY_TABLE} ( ... new_col TEXT, ... );`);
 *
 *   await patchTableSchema(dbQuery, T.MY_TABLE, {
 *     columns: [{ name: "new_col", addSql: "new_col TEXT" }],
 *     columnTypes: [{ name: "old_col", type: "text" }],
 *   });
 * }
 */

export async function ensureColumns(query, tableName, columns = []) {
  for (const col of columns) {
    const name = col?.name;
    const addSql = col?.addSql;
    if (!name || !addSql) continue;

    const found = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       LIMIT 1`,
      [tableName, name]
    );

    if (Array.isArray(found) && found.length > 0) continue;

    await query(`ALTER TABLE ${tableName} ADD COLUMN ${addSql}`);
  }
}

/** Upgrade column type when needed (e.g. VARCHAR(50) → TEXT). No-op if already correct. */
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

/** Drop NOT NULL when an old column was required but should allow NULL now. */
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

/** Run column adds + type upgrades for one table after CREATE TABLE. */
export async function patchTableSchema(query, tableName, { columns = [], columnTypes = [], nullable = [] } = {}) {
  await ensureColumns(query, tableName, columns);

  for (const col of columnTypes) {
    if (col?.name && col?.type) {
      await ensureColumnType(query, tableName, col.name, col.type);
    }
  }

  for (const colName of nullable) {
    await ensureColumnNullable(query, tableName, colName);
  }
}
