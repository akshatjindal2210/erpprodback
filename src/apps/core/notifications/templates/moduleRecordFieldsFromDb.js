import dbQuery from "../../../../config/db/db.js";
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
