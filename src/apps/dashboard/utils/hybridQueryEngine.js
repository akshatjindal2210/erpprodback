import { withTransaction } from "../../../config/db.js";
import { fetchImsDataRaw } from "../../ims/services/ims.service.js";
import { resolveExternalMssqlSql, buildExternalMssqlPayload } from "./externalMssqlQuery.js";
import { validateSelectSql } from "./sqlGenerator.js";

export const TEMP_TABLE = "temp_erp_data";
const TEMP_PLACEHOLDER = /\{\{\s*temp_erp_data\s*\}\}/gi;
const PG_TIMEOUT_MS = 120000;
const BATCH_SIZE = 500;

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function escapeLiteral(value) {
  return String(value).replace(/'/g, "''");
}

export function applyPgRuntimeFilters(rawSql, filters = {}) {
  const fromRaw = filters?.fromDate != null ? String(filters.fromDate).trim() : "";
  const toRaw = filters?.toDate != null ? String(filters.toDate).trim() : "";
  const fromDate = fromRaw ? `${fromRaw} 00:00:00` : "1900-01-01 00:00:00";
  const toDate = toRaw ? `${toRaw} 23:59:59` : "2999-12-31 23:59:59";
  const userId = filters?.userId != null && String(filters.userId).trim() !== ""
    ? Number(filters.userId)
    : null;
  const fyuid = filters?.fyuid != null && String(filters.fyuid).trim() !== ""
    ? Number(filters.fyuid)
    : null;

  return String(rawSql || "")
    .replace(/\{\{\s*fromDate\s*\}\}/gi, `'${escapeLiteral(fromDate)}'`)
    .replace(/\{\{\s*toDate\s*\}\}/gi, `'${escapeLiteral(toDate)}'`)
    .replace(/\{\{\s*userId\s*\}\}/gi, Number.isFinite(userId) ? String(userId) : "NULL")
    .replace(/\{\{\s*fyuid\s*\}\}/gi, Number.isFinite(fyuid) ? String(fyuid) : "NULL");
}

export function inferPgSchema(data) {
  if (!Array.isArray(data) || !data.length) return {};
  const schema = {};
  for (const key of Object.keys(data[0])) {
    const val = data[0][key];
    if (val == null) schema[key] = "TEXT";
    else if (typeof val === "number") schema[key] = Number.isInteger(val) ? "BIGINT" : "NUMERIC";
    else if (typeof val === "boolean") schema[key] = "BOOLEAN";
    else if (val instanceof Date) schema[key] = "TIMESTAMP";
    else schema[key] = "TEXT";
  }
  return schema;
}

export function resolveHybridPgSql(pgQuery, runtimeFilters = {}) {
  return validateSelectSql(
    applyPgRuntimeFilters(pgQuery, runtimeFilters).replace(TEMP_PLACEHOLDER, TEMP_TABLE),
  );
}

export class HybridQueryEngine {
  static async fetchExternalRows(externalConfig, runtimeFilters = {}) {
    const { mssqlQuery, source } = externalConfig;
    const resolved = resolveExternalMssqlSql(mssqlQuery, runtimeFilters);
    const payload = buildExternalMssqlPayload(resolved, source);
    const res = await fetchImsDataRaw(payload.requestedData, payload.filter);
    if (!res.success) throw new Error(`External MSSQL Error: ${res.message}`);
    return Array.isArray(res.records) ? res.records : [];
  }

  static async stageData(client, externalData) {
    const schema = inferPgSchema(externalData);
    const cols = Object.keys(schema);
    if (!cols.length) throw new Error("Cannot stage empty data set.");

    const colDefs = cols.map((c) => `${quoteIdent(c)} ${schema[c]}`).join(", ");
    // Prefer temp-schema drop so we never touch a permanent table of the same name.
    await client.query(`DROP TABLE IF EXISTS pg_temp.${TEMP_TABLE}`);
    await client.query(`CREATE TEMP TABLE ${TEMP_TABLE} (${colDefs}) ON COMMIT DROP`);

    for (let i = 0; i < externalData.length; i += BATCH_SIZE) {
      const batch = externalData.slice(i, i + BATCH_SIZE);
      const placeholders = batch
        .map((_, r) => `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(",")})`)
        .join(",");
      const values = batch.flatMap((row) => cols.map((c) => row[c]));
      await client.query(
        `INSERT INTO ${TEMP_TABLE} (${cols.map(quoteIdent).join(",")}) VALUES ${placeholders}`,
        values,
      );
    }
    return TEMP_TABLE;
  }

  static async previewExternal(externalConfig, runtimeFilters = {}) {
    const rows = await this.fetchExternalRows(externalConfig, runtimeFilters);
    if (!rows.length) throw new Error("External query returned no rows.");
    return {
      columns: Object.keys(rows[0] || {}),
      sampleRows: rows.slice(0, 10),
      externalRowCount: rows.length,
      placeholder: "{{temp_erp_data}}",
    };
  }

  static async executeHybridPreview(externalConfig, pgQuery, runtimeFilters = {}) {
    const externalData = await this.fetchExternalRows(externalConfig, runtimeFilters);
    if (!externalData.length) throw new Error("External query returned no rows.");

    const safeSql = resolveHybridPgSql(pgQuery, runtimeFilters);

    return withTransaction(async (client) => {
      await client.query(`SET LOCAL statement_timeout = ${PG_TIMEOUT_MS}`);
      await this.stageData(client, externalData);
      const { rows } = await client.query(safeSql);
      return {
        rows,
        tmpTableName: TEMP_TABLE,
        rowCount: rows.length,
        externalRowCount: externalData.length,
      };
    });
  }
}
