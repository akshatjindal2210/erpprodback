import {
  EXTERNAL_MSSQL_SOURCES,
  buildExternalMssqlPayload,
  isExternalMssqlDirectRequest,
  isExternalMssqlSource,
  logExternalMssqlInternalRequest,
  parseExternalMssqlDirectRequest,
  resolveExternalMssqlConfig,
  resolveExternalMssqlRuntimeFilters,
  resolveExternalMssqlSql,
  resolveExternalMssqlSqlFromRequest,
  validateExternalMssqlWidgetQuery,
} from "./externalMssqlQuery.js";

export const ERP_MSSQL_REQUESTED_DATA = EXTERNAL_MSSQL_SOURCES.erp_mssql.requestedData;

export {
  EXTERNAL_MSSQL_SOURCES,
  isExternalMssqlSource,
  resolveExternalMssqlConfig,
  validateExternalMssqlWidgetQuery,
};

export const resolveErpMssqlSql = resolveExternalMssqlSql;
export const buildErpMssqlPayload = (resolvedSql = "") => buildExternalMssqlPayload(resolvedSql, "erp_mssql");
export const logErpMssqlInternalRequest = (erpRequest = {}) => logExternalMssqlInternalRequest(erpRequest, "erp_mssql");
export const isErpMssqlDirectRequest = isExternalMssqlDirectRequest;
export const parseErpMssqlDirectRequest = parseExternalMssqlDirectRequest;
export const validateErpMssqlWidgetQuery = (rawQuery = "") => validateExternalMssqlWidgetQuery(rawQuery, "erp_mssql");
export const resolveErpMssqlSqlFromRequest = resolveExternalMssqlSqlFromRequest;
export const resolveErpMssqlRuntimeFilters = resolveExternalMssqlRuntimeFilters;
