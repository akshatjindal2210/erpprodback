export const DASHBOARD_WIDGET_QUERY_PLACEHOLDER = "SELECT ... FROM ... WHERE created_at BETWEEN {{fromDate}} AND {{toDate}} AND username = {{username}}";

/** Raise this (ms) when dashboard widget / internal API queries time out. */
export const DASHBOARD_QUERY_TIMEOUT_MS = 60000;

function quoteSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** SQL values for userid / username / name columns. Missing filter → NULL. */
export function dashboardUserFilterSql(filters = {}) {
  const username = String(filters?.username || "").trim();
  const name = String(filters?.name || "").trim();
  const idNum = Number(filters?.userId ?? filters?.user_id ?? filters?.userid);
  return {
    userIdSql: Number.isInteger(idNum) && idNum > 0 ? String(idNum) : "NULL",
    usernameSql: username ? quoteSqlLiteral(username) : "NULL",
    nameSql: name || username ? quoteSqlLiteral(name || username) : "NULL",
  };
}

/** Super admin with no user selected: `col = {{userId}}` → `col IS NOT NULL` (all rows). */
export function applyDashboardUserPlaceholders(sql, filters = {}) {
  const { userIdSql, usernameSql, nameSql } = dashboardUserFilterSql(filters);
  let resolved = String(sql || "");
  if (filters?.matchAllUsers) {
    resolved = resolved
      .replace(/=\s*\{\{\s*(?:userId|userid|user_id)\s*\}\}/gi, " IS NOT NULL")
      .replace(/=\s*\{\{\s*username\s*\}\}/gi, " IS NOT NULL")
      .replace(/=\s*\{\{\s*name\s*\}\}/gi, " IS NOT NULL");
  }
  return resolved
    .replace(/\{\{\s*userId\s*\}\}/gi, userIdSql)
    .replace(/\{\{\s*userid\s*\}\}/gi, userIdSql)
    .replace(/\{\{\s*user_id\s*\}\}/gi, userIdSql)
    .replace(/\{\{\s*username\s*\}\}/gi, usernameSql)
    .replace(/\{\{\s*name\s*\}\}/gi, nameSql);
}

export function isConfiguredWidgetQuery(query) {
  const normalized = String(query || "").trim();
  if (!normalized) return false;
  if (normalized === DASHBOARD_WIDGET_QUERY_PLACEHOLDER) return false;
  if (/SELECT\s+\.\.\.\s+FROM/i.test(normalized)) return false;
  return true;
}
