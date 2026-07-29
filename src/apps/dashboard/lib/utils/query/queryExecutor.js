import { withTransaction } from "../../../../../config/db/db.js";
import { toSafeLimitedSql } from "./sqlGenerator.js";
import { fetchImsDataRaw } from "../../../../ims/lib/services/ims.service.js";
import { buildExternalMssqlPayload, isExternalMssqlSource, resolveExternalMssqlSql } from "../mssql/externalMssqlQuery.js";
import { HybridQueryEngine } from "./hybridQueryEngine.js";

const QUERY_TIMEOUT_MS = 8000;

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

/** Replace {{fromDate}}, {{toDate}}, {{userId}}, {{fyuid}} in SQL before execution — filter at DB, not in memory. */
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
  const fyuid =
    filters?.fyuid !== undefined && filters?.fyuid !== null && String(filters.fyuid).trim() !== ""
      ? Number(filters.fyuid)
      : null;

  return String(rawSql || "")
    .replace(/\{\{\s*fromDate\s*\}\}/gi, fromDate ? `'${escapeSqlLiteral(fromDate)}'` : "NULL")
    .replace(/\{\{\s*toDate\s*\}\}/gi, toDate ? `'${escapeSqlLiteral(toDate)}'` : "NULL")
    .replace(/\{\{\s*userId\s*\}\}/gi, Number.isFinite(userId) ? String(userId) : "NULL")
    .replace(/\{\{\s*fyuid\s*\}\}/gi, Number.isFinite(fyuid) ? String(fyuid) : "NULL");
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

async function runExternalMssqlReadOnlyQuery(rawSql, filters = {}, source = "erp_mssql") {
  const resolvedSql = resolveExternalMssqlSql(rawSql, filters);
  const erpRequest = buildExternalMssqlPayload(resolvedSql, source);
  const response = await fetchImsDataRaw(erpRequest.requestedData, erpRequest.filter);
  if (!response?.success) {
    throw new Error(response?.message || "External SQL Server query failed.");
  }
  return {
    rows: Array.isArray(response?.records) ? response.records : [],
    erpRequest,
  };
}

export async function executeReadOnlyWidgetQuery(rawSql, options = {}) {
  const source = String(options?.source || "ims_postgresql").toLowerCase();
  const filters = options?.filters && typeof options.filters === "object" ? options.filters : {};
  const isHybrid = options?.is_hybrid === true || source === "hybrid";
  const hybridMssql = String(options?.hybrid_mssql_query || "").trim();

  if (isHybrid) {
    if (!hybridMssql) {
      throw new Error("Hybrid widget is missing the external MSSQL query.");
    }
    const externalSource = isExternalMssqlSource(source)
      ? source
      : String(options?.hybrid_external_source || "erp_mssql").toLowerCase();
    const result = await HybridQueryEngine.executeHybridPreview(
      { mssqlQuery: hybridMssql, source: externalSource },
      rawSql,
      filters,
    );
    return {
      rows: result.rows,
      erpRequest: { hybrid: true, tmpTable: result.tmpTableName },
    };
  }

  if (isExternalMssqlSource(source)) {
    const { rows, erpRequest } = await runExternalMssqlReadOnlyQuery(rawSql, filters, source);
    return {
      rows,
      erpRequest,
    };
  }

  const filteredSql = applyRuntimeFilters(rawSql, filters);
  const rows = await runPostgresReadOnlyQuery(filteredSql);
  return {
    rows,
    erpRequest: null,
  };
}
