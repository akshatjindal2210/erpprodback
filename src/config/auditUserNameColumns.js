/**
 * ONE-TIME migrate only: audit INT user-id cols → TEXT name snapshot.
 *
 * Usage (in that table's createXTable, once):
 *   await migrateTableAuditColumnsToUserNames(dbQuery, T.SOME_TABLE);
 *
 * After prod verified:
 *   1. Remove the migrate call from that *.table.js
 *   2. When no table calls this anymore — delete this whole file
 *
 * Permanent pieces live elsewhere (do NOT import this for reads/writes):
 *   - auditUserName / applyApprovalWorkflow({ auditAsName: true }) → core/utils/approval.js
 *   - list fields: inline "ps.created_by AS created_by_name" etc. in model
 */

import { MST_TABLES as C } from "./dbTables.js";
import { columnExists } from "./ensureDbColumns.js";

export const DEFAULT_AUDIT_NAME_COLS = ["created_by", "updated_by", "approved_by", "deleted_by"];

function isTextLike(meta) {
  const t = String(meta?.udt_name || meta?.data_type || "").toLowerCase();
  return t === "text" || t === "varchar" || t === "character varying";
}

async function getColumnMeta(query, tableName, columnName) {
  const rows = await query(
    `SELECT data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return rows?.[0] ?? null;
}

async function dropFkConstraintsForColumns(query, tableName, columns = []) {
  for (const col of columns) {
    const rows = await query(
      `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
       WHERE n.nspname = 'public'
         AND t.relname = $1
         AND c.contype = 'f'
         AND a.attname = $2`,
      [tableName, col]
    );

    for (const row of rows || []) {
      if (!row?.conname) continue;
      await query(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${row.conname}`);
    }
  }
}

async function hasNumericIdValues(query, tableName, columns = []) {
  for (const col of columns) {
    const rows = await query(
      `SELECT 1 FROM ${tableName}
       WHERE ${col} IS NOT NULL AND ${col}::text ~ '^[0-9]+$'
       LIMIT 1`
    );
    if (Array.isArray(rows) && rows.length) return true;
  }
  return false;
}

/** One-shot: FK drop → TEXT → backfill id → mst_users.name. Safe no-op when already done. */
export async function migrateTableAuditColumnsToUserNames(
  query,
  tableName,
  { columns = DEFAULT_AUDIT_NAME_COLS, usersTable = C.USERS } = {}
) {
  if (!tableName || !Array.isArray(columns) || !columns.length) return;

  const existingCols = [];
  for (const col of columns) {
    if (await columnExists(query, tableName, col)) existingCols.push(col);
  }
  if (!existingCols.length) return;

  let needsTypeChange = false;
  for (const col of existingCols) {
    const meta = await getColumnMeta(query, tableName, col);
    if (meta && !isTextLike(meta)) {
      needsTypeChange = true;
      break;
    }
  }

  if (!needsTypeChange && !(await hasNumericIdValues(query, tableName, existingCols))) {
    return;
  }

  await dropFkConstraintsForColumns(query, tableName, existingCols);

  for (const col of existingCols) {
    const meta = await getColumnMeta(query, tableName, col);
    if (!meta || isTextLike(meta)) continue;

    await query(`
      ALTER TABLE ${tableName}
      ALTER COLUMN ${col} TYPE TEXT
      USING CASE WHEN ${col} IS NULL THEN NULL ELSE ${col}::text END
    `);
  }

  for (const col of existingCols) {
    await query(
      `UPDATE ${tableName} t
       SET ${col} = u.name
       FROM ${usersTable} u
       WHERE t.${col} IS NOT NULL
         AND t.${col} ~ '^[0-9]+$'
         AND u.id = t.${col}::integer`
    );
  }
}
