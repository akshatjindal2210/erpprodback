import { withTransaction } from "../../../../../config/db/db.js";
import { fetchImsDataRaw } from "../../../../ims/lib/services/ims.service.js";
import { resolveExternalMssqlSql, buildExternalMssqlPayload } from "../mssql/externalMssqlQuery.js";
import { validateSelectSql } from "./sqlGenerator.js";
import { fetchUrlJsonRows } from "./urlJsonQuery.js";
import { DASHBOARD_QUERY_TIMEOUT_MS, applyDashboardUserPlaceholders } from "./widgetQuery.js";

export const TEMP_TABLE = "temp_erp_data";
const TEMP_PLACEHOLDER = /\{\{\s*temp_erp_data\s*\}\}/gi;
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
  const fyuid = filters?.fyuid != null && String(filters.fyuid).trim() !== ""
    ? Number(filters.fyuid)
    : null;

  return applyDashboardUserPlaceholders(
    String(rawSql || "")
      .replace(/\{\{\s*fromDate\s*\}\}/gi, `'${escapeLiteral(fromDate)}'`)
      .replace(/\{\{\s*toDate\s*\}\}/gi, `'${escapeLiteral(toDate)}'`),
    filters,
  ).replace(/\{\{\s*fyuid\s*\}\}/gi, Number.isFinite(fyuid) ? String(fyuid) : "NULL");
}

function pgTypeForValue(val) {
  if (val == null) return "TEXT";
  if (typeof val === "number") return Number.isInteger(val) ? "BIGINT" : "NUMERIC";
  if (typeof val === "boolean") return "BOOLEAN";
  if (val instanceof Date) return "TIMESTAMP";
  return "TEXT";
}

export function inferPgSchema(data) {
  if (!Array.isArray(data) || !data.length) return {};
  const schema = {};
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const [key, val] of Object.entries(row)) {
      if (schema[key] && schema[key] !== "TEXT") continue;
      const nextType = pgTypeForValue(val);
      if (!schema[key] || (schema[key] === "TEXT" && val != null && nextType !== "TEXT")) {
        schema[key] = nextType;
      }
    }
  }
  return schema;
}

export function resolveHybridPgSql(pgQuery, runtimeFilters = {}) {
  return validateSelectSql(
    applyPgRuntimeFilters(pgQuery, runtimeFilters).replace(TEMP_PLACEHOLDER, TEMP_TABLE),
  );
}

export class HybridQueryEngine {
  /** Step 1 → rows. ERP/HRMS path unchanged; URL only adds a branch before it. */
  static async fetchExternalRows(externalConfig, runtimeFilters = {}) {
    const source = String(externalConfig?.source || "erp_mssql").trim().toLowerCase();

    if (source === "url_json") {
      const url = String(externalConfig?.url || "").trim();
      if (!url) throw new Error("Hybrid URL is required.");
      const rawRows = await fetchUrlJsonRows(url, {
        method: externalConfig?.urlMethod,
        body: externalConfig?.urlBody,
      });
      // Same shape MSSQL returns: flat object rows (required by stageData / inferPgSchema).
      const rows = (Array.isArray(rawRows) ? rawRows : [])
        .filter((row) => row && typeof row === "object" && !Array.isArray(row))
        .map((row) => {
          const out = {};
          for (const [key, value] of Object.entries(row)) {
            if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
              out[key] = value;
            } else if (value instanceof Date) {
              out[key] = value;
            } else {
              out[key] = JSON.stringify(value);
            }
          }
          return out;
        });
      if (!rows.length) {
        throw new Error("API JSON must include an array of object records (e.g. [{ \"col\": 1 }]).");
      }
      return rows;
    }

    const { mssqlQuery } = externalConfig;
    const resolved = resolveExternalMssqlSql(mssqlQuery, runtimeFilters);
    const payload = buildExternalMssqlPayload(resolved, source);
    const res = await fetchImsDataRaw(payload.requestedData, payload.filter, {
      timeoutMs: DASHBOARD_QUERY_TIMEOUT_MS,
    });
    if (!res.success) {
      const detail = String(res?.message || res?.error || "Unknown error").trim();
      throw new Error(`External MSSQL Error: ${detail}`);
    }
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
      await client.query(`SET LOCAL statement_timeout = ${DASHBOARD_QUERY_TIMEOUT_MS}`);
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
