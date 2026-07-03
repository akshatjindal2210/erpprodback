import { withTransaction } from "../../../config/db.js";
import { toSafeLimitedSql } from "./sqlGenerator.js";
import { fetchImsDataRaw } from "../../ims/services/ims.service.js";

const QUERY_TIMEOUT_MS = 8000;
const DATE_FILTER_KEYS = ["created_at", "createdat", "created_on", "createdon", "date", "doc_dt", "docdt", "approved_at", "updated_at"];
const USER_FILTER_KEYS = ["created_by", "createdby", "user_id", "userid", "usercode", "approved_by", "updated_by"];

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function applyRuntimeFilters(rawSql, filters = {}) {
  const fromDate =
    filters?.fromDate && String(filters.fromDate).trim()
      ? `${String(filters.fromDate).trim()} 00:00:00`
      : "1900-01-01 00:00:00";
  const toDate =
    filters?.toDate && String(filters.toDate).trim()
      ? `${String(filters.toDate).trim()} 23:59:59`
      : "2999-12-31 23:59:59";
  const userId =
    filters?.userId !== undefined && filters?.userId !== null && String(filters.userId).trim() !== ""
      ? Number(filters.userId)
      : null;

  return String(rawSql || "")
    .replace(/\{\{\s*fromDate\s*\}\}/gi, fromDate ? `'${escapeSqlLiteral(fromDate)}'` : "NULL")
    .replace(/\{\{\s*toDate\s*\}\}/gi, toDate ? `'${escapeSqlLiteral(toDate)}'` : "NULL")
    .replace(/\{\{\s*userId\s*\}\}/gi, Number.isFinite(userId) ? String(userId) : "NULL");
}

async function runPostgresReadOnlyQuery(rawSql) {
  const safeSql = toSafeLimitedSql(rawSql);

  return withTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    await client.query("SET TRANSACTION READ ONLY");
    const result = await client.query(safeSql);
    return result.rows || [];
  });
}

function parseDateMs(value, endOfDay = false) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  if (!text) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const parsed = new Date(dateOnly ? `${text}T${endOfDay ? "23:59:59" : "00:00:00"}` : text);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function findValueByKeys(row, keys) {
  if (!row || typeof row !== "object") return undefined;
  const lookup = new Map(Object.keys(row).map((key) => [String(key).toLowerCase(), key]));
  for (const key of keys) {
    const actual = lookup.get(key);
    if (actual) return row[actual];
  }
  return undefined;
}

function applyResultFilters(rows = [], filters = {}) {
  if (!Array.isArray(rows)) return [];
  const fromMs = parseDateMs(filters?.fromDate);
  const toMs = parseDateMs(filters?.toDate, true);
  const userId = filters?.userId !== undefined && filters?.userId !== null && String(filters.userId).trim() !== ""
    ? String(filters.userId).trim()
    : "";
  if (!fromMs && !toMs && !userId) return rows;

  return rows.filter((row) => {
    if (fromMs || toMs) {
      const value = findValueByKeys(row, DATE_FILTER_KEYS);
      const rowMs = parseDateMs(value);
      if (rowMs !== null) {
        if (fromMs && rowMs < fromMs) return false;
        if (toMs && rowMs > toMs) return false;
      }
    }
    if (userId) {
      const value = findValueByKeys(row, USER_FILTER_KEYS);
      if (value !== undefined && value !== null && String(value).trim() !== userId) return false;
    }
    return true;
  });
}

async function runErpReadOnlyQuery(rawSql, filters = {}, erpFilter = {}) {
  const rawValue = String(rawSql || "").trim();
  if (!rawValue) {
    throw new Error("requestedData is required for MSSQL source.");
  }
  let requestedData = rawValue;
  let baseFilter = erpFilter && typeof erpFilter === "object" ? erpFilter : {};
  if (rawValue.startsWith("{") && rawValue.endsWith("}")) {
    try {
      const payload = JSON.parse(rawValue);
      if (payload && typeof payload === "object") {
        requestedData = String(payload.requestedData || payload.requested_data || "").trim();
        baseFilter = payload.filter ?? {};
      }
    } catch (_error) {
      throw new Error("Invalid MSSQL payload JSON.");
    }
  }
  if (!requestedData) {
    throw new Error("requestedData is required in MSSQL payload.");
  }
  const mergedFilter =
    typeof baseFilter === "string"
      ? applyRuntimeFilters(baseFilter, filters)
      : {
          ...(baseFilter && typeof baseFilter === "object" ? baseFilter : {}),
          fromDate: filters?.fromDate || null,
          toDate: filters?.toDate || null,
          userId: filters?.userId || null,
        };
  const response = await fetchImsDataRaw(requestedData, mergedFilter);
  if (!response?.success) {
    throw new Error(response?.message || "ERP data source query failed.");
  }
  return Array.isArray(response?.records) ? response.records : [];
}

export async function executeReadOnlyWidgetQuery(rawSql, options = {}) {
  const source = String(options?.source || "ims_postgresql").toLowerCase();
  const filters = options?.filters && typeof options.filters === "object" ? options.filters : {};
  const erpFilter = options?.erpFilter && typeof options.erpFilter === "object" ? options.erpFilter : {};
  const filteredSql = applyRuntimeFilters(rawSql, filters);
  if (source === "erp_mssql") {
    const rows = await runErpReadOnlyQuery(filteredSql, filters, erpFilter);
    return applyResultFilters(rows, filters);
  }
  const rows = await runPostgresReadOnlyQuery(filteredSql);
  return applyResultFilters(rows, filters);
}

