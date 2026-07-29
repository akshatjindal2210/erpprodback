import { validateSelectSql } from "../query/sqlGenerator.js";

export const EXTERNAL_MSSQL_SOURCES = {
  erp_mssql: {
    key: "erp_mssql",
    requestedData: "erp_mssql",
    tablesRequestedData: "dashboard_tables",
    label: "SQL Server (ERP)",
  },
  hrms_mssql: {
    key: "hrms_mssql",
    requestedData: "hrms_mssql",
    tablesRequestedData: "hrms_dashboard_tables",
    label: "SQL Server (HRMS)",
  },
};

const PLACEHOLDER_PATTERN = /\{\{\s*[\w.]+\s*\}\}/g;

export function isExternalMssqlSource(rawValue = "") {
  const key = String(rawValue || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EXTERNAL_MSSQL_SOURCES, key);
}

export function resolveExternalMssqlConfig(rawValue = "erp_mssql") {
  const key = String(rawValue || "").trim().toLowerCase();
  return EXTERNAL_MSSQL_SOURCES[key] || EXTERNAL_MSSQL_SOURCES.erp_mssql;
}

function isSelectLikeSql(raw = "") {
  const upper = String(raw || "").trim().toUpperCase();
  return upper.startsWith("SELECT") || upper.startsWith("WITH");
}

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

/** Replace {{fromDate}}, {{toDate}}, {{userId}}, {{fyuid}} before external SQL Server call. */
export function resolveExternalMssqlSql(sql = "", runtimeFilters = {}) {
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
  const fyuid =
    filters?.fyuid !== undefined && filters?.fyuid !== null && String(filters.fyuid).trim() !== ""
      ? Number(filters.fyuid)
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
  if (/\{\{\s*fyuid\s*\}\}/i.test(resolved)) {
    if (!Number.isFinite(fyuid)) {
      throw new Error("runtime_filters.fyuid is required when SQL uses {{fyuid}}. Select a financial year first.");
    }
    resolved = resolved.replace(/\{\{\s*fyuid\s*\}\}/gi, String(fyuid));
  }
  if (PLACEHOLDER_PATTERN.test(resolved)) {
    throw new Error("Unresolved placeholders in SQL. Replace all {{...}} before SQL Server request.");
  }
  return resolved.trim();
}

export function buildExternalMssqlPayload(resolvedSql = "", source = "erp_mssql") {
  const config = resolveExternalMssqlConfig(source);
  const sql = String(resolvedSql || "").trim();
  if (!sql) {
    throw new Error(`SELECT query is required for ${config.label}.`);
  }
  if (!isSelectLikeSql(sql)) {
    throw new Error(`Only SELECT/CTE queries are allowed for ${config.label}.`);
  }
  return {
    requestedData: config.requestedData,
    filter: validateSelectSql(sql),
  };
}

export function logExternalMssqlInternalRequest(erpRequest = {}, source = "erp_mssql") {
  const config = resolveExternalMssqlConfig(source);
  const payload = {
    requestedData: erpRequest.requestedData || config.requestedData,
    filter: erpRequest.filter ?? "",
  };
  console.log(`[${config.requestedData}] hitting internal API with:`, JSON.stringify(payload, null, 2));
  return payload;
}

export function isExternalMssqlDirectRequest(body = {}, query = {}) {
  const requestedData = String(
    body?.requestedData || body?.requested_data || query?.requestedData || query?.requested_data || "",
  ).trim().toLowerCase();
  const filter = body?.filter ?? query?.filter;
  return isExternalMssqlSource(requestedData) && typeof filter === "string" && filter.trim().length > 0;
}

export function parseExternalMssqlDirectRequest(body = {}, query = {}) {
  const requestedData = String(
    body?.requestedData || body?.requested_data || query?.requestedData || query?.requested_data || "",
  ).trim().toLowerCase();
  const filter = String(body?.filter ?? query?.filter ?? "").trim();
  return {
    requestedData: isExternalMssqlSource(requestedData) ? requestedData : "erp_mssql",
    filter,
    runtimeFilters: resolveExternalMssqlRuntimeFilters(body, query),
  };
}

export function validateExternalMssqlWidgetQuery(rawQuery = "", source = "erp_mssql") {
  const config = resolveExternalMssqlConfig(source);
  const sql = String(rawQuery || "").trim();
  if (!sql) {
    throw new Error(`SELECT query is required for ${config.label}.`);
  }
  if (!isSelectLikeSql(sql)) {
    throw new Error(`Only SELECT/CTE queries are allowed for ${config.label}.`);
  }
}

export function resolveExternalMssqlSqlFromRequest(body = {}, query = {}) {
  if (isExternalMssqlDirectRequest(body, query)) {
    return String(body?.filter ?? query?.filter ?? "").trim();
  }
  const filtersField = body?.filters ?? query?.filters;
  if (typeof filtersField === "string" && filtersField.trim()) {
    return filtersField.trim();
  }
  return String(body?.query || query?.query || "").trim();
}

export function resolveExternalMssqlRuntimeFilters(body = {}, query = {}) {
  const runtime = body?.runtime_filters ?? query?.runtime_filters;
  if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
    return runtime;
  }
  return {};
}
