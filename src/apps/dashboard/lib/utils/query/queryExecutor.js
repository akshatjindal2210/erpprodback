import { withTransaction } from "../../../../../config/db/db.js";
import { toSafeLimitedSql } from "./sqlGenerator.js";
import { fetchImsDataRaw } from "../../../../ims/lib/services/ims.service.js";
import { buildExternalMssqlPayload, isExternalMssqlSource, resolveExternalMssqlSql } from "../mssql/externalMssqlQuery.js";
import { HybridQueryEngine } from "./hybridQueryEngine.js";
import { fetchUrlJsonRows } from "./urlJsonQuery.js";
import { DASHBOARD_QUERY_TIMEOUT_MS, applyDashboardUserPlaceholders } from "./widgetQuery.js";

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
  const fyuid =
    filters?.fyuid !== undefined && filters?.fyuid !== null && String(filters.fyuid).trim() !== ""
      ? Number(filters.fyuid)
      : null;

  return applyDashboardUserPlaceholders(
    String(rawSql || "")
      .replace(/\{\{\s*fromDate\s*\}\}/gi, `'${escapeSqlLiteral(fromDate)}'`)
      .replace(/\{\{\s*toDate\s*\}\}/gi, `'${escapeSqlLiteral(toDate)}'`),
    filters,
  ).replace(/\{\{\s*fyuid\s*\}\}/gi, Number.isFinite(fyuid) ? String(fyuid) : "NULL");
}

function formatQueryEngineError(error, sourceLabel = "Database") {
  const message = String(error?.message || "Query failed.").trim();
  const detail = String(error?.detail || "").trim();
  const hint = String(error?.hint || "").trim();
  const code = String(error?.code || "").trim();
  const parts = [`${sourceLabel}: ${message}`];
  if (detail) parts.push(`Detail: ${detail}`);
  if (hint) parts.push(`Hint: ${hint}`);
  if (code) parts.push(`Code: ${code}`);
  return parts.join(" ");
}

async function runPostgresReadOnlyQuery(rawSql) {
  const safeSql = toSafeLimitedSql(rawSql);

  try {
    return await withTransaction(async (client) => {
      await client.query(`SET LOCAL statement_timeout = ${DASHBOARD_QUERY_TIMEOUT_MS}`);
      await client.query("SET TRANSACTION READ ONLY");
      const result = await client.query(safeSql);
      return result.rows || [];
    });
  } catch (error) {
    throw new Error(formatQueryEngineError(error, "PostgreSQL"));
  }
}

async function runExternalMssqlReadOnlyQuery(rawSql, filters = {}, source = "erp_mssql") {
  const resolvedSql = resolveExternalMssqlSql(rawSql, filters);
  const erpRequest = buildExternalMssqlPayload(resolvedSql, source);
  const response = await fetchImsDataRaw(erpRequest.requestedData, erpRequest.filter, {
    timeoutMs: DASHBOARD_QUERY_TIMEOUT_MS,
  });
  if (!response?.success) {
    const label = source === "hrms_mssql" ? "HRMS SQL Server" : "ERP SQL Server";
    const detail = String(response?.message || response?.error || "External SQL Server query failed.").trim();
    throw new Error(`${label}: ${detail}`);
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

  if (source === "url_json") {
    return {
      rows: await fetchUrlJsonRows(rawSql, {
        method: options?.url_method,
        body: options?.url_body,
        excludedColumns: options?.url_excluded_columns,
      }),
      erpRequest: null,
    };
  }

  if (isHybrid) {
    const externalSource = isExternalMssqlSource(source)
      ? source
      : String(options?.hybrid_external_source || "erp_mssql").toLowerCase();

    // Hybrid Step 1 = URL → same temp table + PG merge as ERP/HRMS
    if (externalSource === "url_json") {
      const url = String(options?.hybrid_url || "").trim();
      if (!url) throw new Error("Hybrid widget is missing the external API URL.");
      const result = await HybridQueryEngine.executeHybridPreview(
        {
          source: "url_json",
          url,
          urlMethod: options?.hybrid_url_method,
          urlBody: options?.hybrid_url_body,
        },
        rawSql,
        filters,
      );
      return {
        rows: result.rows,
        erpRequest: { hybrid: true, tmpTable: result.tmpTableName },
      };
    }

    if (!hybridMssql) {
      throw new Error("Hybrid widget is missing the external MSSQL query.");
    }
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
