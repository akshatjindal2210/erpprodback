import { validateSelectSql } from "./sqlGenerator.js";

export const ERP_MSSQL_REQUESTED_DATA = "erp_mssql";

const PLACEHOLDER_PATTERN = /\{\{\s*[\w.]+\s*\}\}/g;

function isSelectLikeSql(raw = "") {
  const upper = String(raw || "").trim().toUpperCase();
  return upper.startsWith("SELECT") || upper.startsWith("WITH");
}

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

/** Replace {{fromDate}}, {{toDate}}, {{userId}} before ERP call — never send placeholders to ERP. */
export function resolveErpMssqlSql(sql = "", runtimeFilters = {}) {
  const filters = runtimeFilters && typeof runtimeFilters === "object" ? runtimeFilters : {};
  const fromDate =
    filters?.fromDate && String(filters.fromDate).trim()
      ? `${String(filters.fromDate).trim()} 00:00:00`
      : "";
  const toDate =
    filters?.toDate && String(filters.toDate).trim()
      ? `${String(filters.toDate).trim()} 23:59:59`
      : "";
  const userId =
    filters?.userId !== undefined && filters?.userId !== null && String(filters.userId).trim() !== ""
      ? Number(filters.userId)
      : null;

  let resolved = String(sql || "");
  if (/\{\{\s*fromDate\s*\}\}/i.test(resolved)) {
    if (!fromDate) {
      throw new Error("runtime_filters.fromDate is required when SQL uses {{fromDate}}.");
    }
    resolved = resolved.replace(/\{\{\s*fromDate\s*\}\}/gi, `'${escapeSqlLiteral(fromDate)}'`);
  }
  if (/\{\{\s*toDate\s*\}\}/i.test(resolved)) {
    if (!toDate) {
      throw new Error("runtime_filters.toDate is required when SQL uses {{toDate}}.");
    }
    resolved = resolved.replace(/\{\{\s*toDate\s*\}\}/gi, `'${escapeSqlLiteral(toDate)}'`);
  }
  if (/\{\{\s*userId\s*\}\}/i.test(resolved)) {
    if (!Number.isFinite(userId)) {
      throw new Error("runtime_filters.userId is required when SQL uses {{userId}}.");
    }
    resolved = resolved.replace(/\{\{\s*userId\s*\}\}/gi, String(userId));
  }
  if (PLACEHOLDER_PATTERN.test(resolved)) {
    throw new Error("Unresolved placeholders in SQL. Replace all {{...}} before ERP request.");
  }
  return resolved.trim();
}

export function buildErpMssqlPayload(resolvedSql = "") {
  const sql = String(resolvedSql || "").trim();
  if (!sql) {
    throw new Error("SELECT query is required for ERP (MSSQL External).");
  }
  if (!isSelectLikeSql(sql)) {
    throw new Error("Only SELECT/CTE queries are allowed for ERP (MSSQL External).");
  }
  return {
    requestedData: ERP_MSSQL_REQUESTED_DATA,
    filter: validateSelectSql(sql),
  };
}

/** Console log before ERP internal API call (debug). */
export function logErpMssqlInternalRequest(erpRequest = {}) {
  const payload = {
    requestedData: erpRequest.requestedData || ERP_MSSQL_REQUESTED_DATA,
    filter: erpRequest.filter ?? "",
  };
  console.log("[erp_mssql] hitting internal API with:", JSON.stringify(payload, null, 2));
  return payload;
}

/** Postman / preview body: { requestedData: "erp_mssql", filter: "SELECT ..." } */
export function isErpMssqlDirectRequest(body = {}, query = {}) {
  const requestedData = String(
    body?.requestedData || body?.requested_data || query?.requestedData || query?.requested_data || "",
  ).trim().toLowerCase();
  const filter = body?.filter ?? query?.filter;
  return requestedData === ERP_MSSQL_REQUESTED_DATA && typeof filter === "string" && filter.trim().length > 0;
}

export function parseErpMssqlDirectRequest(body = {}, query = {}) {
  const filter = String(body?.filter ?? query?.filter ?? "").trim();
  return {
    requestedData: ERP_MSSQL_REQUESTED_DATA,
    filter,
    runtimeFilters: resolveErpMssqlRuntimeFilters(body, query),
  };
}

export function validateErpMssqlWidgetQuery(rawQuery = "") {
  const sql = String(rawQuery || "").trim();
  if (!sql) {
    throw new Error("SELECT query is required for ERP (MSSQL External).");
  }
  if (!isSelectLikeSql(sql)) {
    throw new Error("Only SELECT/CTE queries are allowed for ERP (MSSQL External).");
  }
}

/** API/body: erp_mssql SQL in `filter` (with requestedData). Legacy: `filters` string or `query`. */
export function resolveErpMssqlSqlFromRequest(body = {}, query = {}) {
  if (isErpMssqlDirectRequest(body, query)) {
    return String(body?.filter ?? query?.filter ?? "").trim();
  }
  const filtersField = body?.filters ?? query?.filters;
  if (typeof filtersField === "string" && filtersField.trim()) {
    return filtersField.trim();
  }
  return String(body?.query || query?.query || "").trim();
}

/** Date/user values for {{fromDate}} etc. — `runtime_filters` object only. */
export function resolveErpMssqlRuntimeFilters(body = {}, query = {}) {
  const runtime = body?.runtime_filters ?? query?.runtime_filters;
  if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
    return runtime;
  }
  return {};
}
