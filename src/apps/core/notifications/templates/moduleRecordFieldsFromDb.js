import dbQuery from "../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../config/db/dbTables.js";
import { resolvePrimaryTableForModule } from "../../../../config/db/moduleTableMap.js";

const COLUMN_CACHE_TTL_MS = 5 * 60_000;
const columnCache = new Map();

const SKIP_COLUMNS = new Set(["password", "password_hash", "otp", "token", "secret", "refresh_token", "access_token"]);

function titleCase(key) {
  return String(key || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function getTableColumns(tableName) {
  const table = String(tableName || "").trim();
  if (!table) return [];

  const hit = columnCache.get(table);
  if (hit && Date.now() - hit.at < COLUMN_CACHE_TTL_MS) return hit.cols;

  const rows = await dbQuery(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);

  const cols = rows.map((r) => r.column_name).filter((c) => c && !SKIP_COLUMNS.has(String(c).toLowerCase()));

  columnCache.set(table, { at: Date.now(), cols });
  return cols;
}

/** Template form: {{column_name}} chips from information_schema (updates when table columns change). */
export async function recordVariableHintsByModules(modules = []) {
  const out = {};
  const seenTables = new Map();

  for (const m of modules) {
    const moduleName = m?.name;
    if (!moduleName) continue;

    const table = resolvePrimaryTableForModule(moduleName, m.app_type);
    if (!table) continue;

    let cols = seenTables.get(table);
    if (!cols) {
      cols = await getTableColumns(table);
      seenTables.set(table, cols);
    }

    if (cols.length) {
      out[moduleName] = cols.map((key) => ({ key, label: titleCase(key) }));
    }
  }

  return out;
}

const SAFE_COL = /^[a-z_][a-z0-9_]*$/i;
const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/i;

/** Master-table fields used in conditions (DISTINCT from DB column). */
const VIRTUAL_DISTINCT = {
  department: { table: M.DEPARTMENTS, column: "name" },
  designation: { table: M.DESIGNATIONS, column: "name" },
  department_id: { table: M.DEPARTMENTS, column: "id" },
};

async function distinctColumnText(table, column) {
  if (!SAFE_TABLE.test(table) || !SAFE_COL.test(column)) return [];
  const rows = await dbQuery(
    `SELECT DISTINCT ${column}::text AS v FROM ${table} WHERE ${column} IS NOT NULL ORDER BY 1 LIMIT 100`
  );
  return rows.map((r) => r.v).filter((v) => v != null && String(v).trim() !== "");
}

/** DISTINCT values already stored in the module primary table column (whitelist). */
export async function distinctValuesForModuleField({ moduleName, appType, field }) {
  const fieldKey = String(field || "").trim();
  if (!fieldKey || !SAFE_COL.test(fieldKey)) return [];

  const virt = VIRTUAL_DISTINCT[fieldKey];
  if (virt) {
    const col = String(virt.column || "").trim();
    if (!SAFE_COL.test(col)) return [];
    return distinctColumnText(virt.table, col);
  }

  const table = resolvePrimaryTableForModule(moduleName, appType);
  if (!table) return [];

  const cols = await getTableColumns(table);
  if (!cols.includes(fieldKey)) return [];

  return distinctColumnText(table, fieldKey);
}
