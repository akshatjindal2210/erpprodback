export const DASHBOARD_WIDGET_QUERY_PLACEHOLDER = "SELECT ... FROM ... WHERE created_at BETWEEN {{fromDate}} AND {{toDate}} AND username = {{username}}";

/** Raise this (ms) when dashboard widget / internal API queries time out. */
export const DASHBOARD_QUERY_TIMEOUT_MS = 60000;

/**
 * Session-only tokens (`{{key}}`).
 * Future: one row here + FE chip. `kind: "number"` = unquoted id (like userId); default string = quoted.
 */
export const DASHBOARD_SESSION_STRING_FILTERS = [
  { key: "type", kind: "string", fromUser: (u) => u?.type || u?.role },
  {
    key: "designationId",
    kind: "number",
    aliases: ["designation_id"],
    fromUser: (u) => u?.designation_id ?? u?.designation?.id,
  },
  {
    key: "departmentId",
    kind: "number",
    aliases: ["department_id"],
    fromUser: (u) => u?.department_id ?? u?.department?.id,
  },
];

function quoteSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sessionFilterSqlValue(kind, raw) {
  if (kind === "number") {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? String(n) : "NULL";
  }
  const text = String(raw ?? "").trim();
  return text ? quoteSqlLiteral(text) : "NULL";
}

/** Values for `{{type}}` / `{{designationId}}` / `{{departmentId}}` / … from `req.user`. */
export function sessionIdentityFilterValues(user) {
  const out = {};
  for (const { key, kind = "string", fromUser } of DASHBOARD_SESSION_STRING_FILTERS) {
    const raw = fromUser?.(user);
    if (kind === "number") {
      const n = Number(raw);
      out[key] = Number.isInteger(n) && n > 0 ? n : null;
    } else {
      const text = String(raw ?? "").trim();
      out[key] = text || null;
    }
  }
  return out;
}

function applySessionStringPlaceholders(sql, filters = {}) {
  let resolved = String(sql || "");
  for (const { key, kind = "string", aliases = [] } of DASHBOARD_SESSION_STRING_FILTERS) {
    const sqlVal = sessionFilterSqlValue(kind, filters?.[key]);
    const tokens = [key, ...aliases];
    for (const token of tokens) {
      resolved = resolved.replace(new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, "gi"), sqlVal);
    }
  }
  return resolved;
}

/** SQL values for userid / username / name. Missing filter → NULL. */
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

function sqlInList(values, { numeric = false } = {}) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => {
      if (numeric) {
        const n = Number(value);
        return Number.isInteger(n) && n > 0 ? String(n) : null;
      }
      const text = String(value || "").trim();
      return text ? quoteSqlLiteral(text) : null;
    })
    .filter(Boolean);
  return list.length ? list.join(", ") : "NULL";
}

/**
 * - matchAllUsers: `= {{userId}}` → `IS NOT NULL`
 * - matchTeamUsers (manager dept): `= {{userId}}` → `IN (…)`
 * - session filters: DASHBOARD_SESSION_STRING_FILTERS
 */
export function applyDashboardUserPlaceholders(sql, filters = {}) {
  const { userIdSql, usernameSql, nameSql } = dashboardUserFilterSql(filters);
  let resolved = String(sql || "");
  if (filters?.matchAllUsers) {
    resolved = resolved
      .replace(/=\s*\{\{\s*(?:userId|userid|user_id)\s*\}\}/gi, " IS NOT NULL")
      .replace(/=\s*\{\{\s*username\s*\}\}/gi, " IS NOT NULL")
      .replace(/=\s*\{\{\s*name\s*\}\}/gi, " IS NOT NULL");
  } else if (filters?.matchTeamUsers) {
    const idIn = sqlInList(filters.teamUserIds, { numeric: true });
    const usernameIn = sqlInList(filters.teamUsernames);
    const nameIn = sqlInList(filters.teamNames);
    resolved = resolved
      .replace(/=\s*\{\{\s*(?:userId|userid|user_id)\s*\}\}/gi, ` IN (${idIn})`)
      .replace(/=\s*\{\{\s*username\s*\}\}/gi, ` IN (${usernameIn})`)
      .replace(/=\s*\{\{\s*name\s*\}\}/gi, ` IN (${nameIn})`);
  }
  resolved = resolved
    .replace(/\{\{\s*userId\s*\}\}/gi, userIdSql)
    .replace(/\{\{\s*userid\s*\}\}/gi, userIdSql)
    .replace(/\{\{\s*user_id\s*\}\}/gi, userIdSql)
    .replace(/\{\{\s*username\s*\}\}/gi, usernameSql)
    .replace(/\{\{\s*name\s*\}\}/gi, nameSql);
  return applySessionStringPlaceholders(resolved, filters);
}

export function isConfiguredWidgetQuery(query) {
  const normalized = String(query || "").trim();
  if (!normalized) return false;
  if (normalized === DASHBOARD_WIDGET_QUERY_PLACEHOLDER) return false;
  if (/SELECT\s+\.\.\.\s+FROM/i.test(normalized)) return false;
  return true;
}
