import { fetchImsDataRaw } from "../../../services/ims.service.js";

const EXTERNAL_DATA_CACHE_TTL_MS = 5000;
const externalDataCache = new Map();
const externalDataInflight = new Map();

function normalizeKeyPart(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (!s) return "";
  const n = Number(s);
  if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s)) {
    return Number.isInteger(n) ? String(n) : String(n).replace(/\.0+$/, "");
  }
  return s;
}

export function buildCompositeKey(parts = []) {
  const normalized = parts.map((part) => normalizeKeyPart(part));
  if (normalized.some((part) => !part)) return null;
  return normalized.join("-");
}

function asArray(records) {
  return Array.isArray(records) ? records : [];
}

async function getExternalRequestedData(requestedData) {
  const key = String(requestedData || "").trim();
  if (!key) return [];

  const now = Date.now();
  const cached = externalDataCache.get(key);
  if (cached && now - cached.at <= EXTERNAL_DATA_CACHE_TTL_MS) {
    return cached.records;
  }

  if (externalDataInflight.has(key)) {
    return externalDataInflight.get(key);
  }

  const promise = (async () => {
    const res = await fetchImsDataRaw(key);
    if (!res?.success) {
      console.warn("[FORWARDING][EXTERNAL] IMS fetch failed:", key, res?.message || "Unknown IMS error");
      externalDataCache.set(key, { at: Date.now(), records: [] });
      return [];
    }
    const records = asArray(res.records);
    externalDataCache.set(key, { at: Date.now(), records });
    return records;
  })()
    .finally(() => {
      externalDataInflight.delete(key);
    });

  externalDataInflight.set(key, promise);
  return promise;
}

async function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve([]), timeoutMs);
    }),
  ]);
}

/** Same IMS cache + timeout as mergeRowsWithExternalData. */
export async function fetchExternalRecords(requestedData, timeoutMs = 2000) {
  const key = String(requestedData || "").trim();
  if (!key) return [];
  try {
    return await withTimeout(getExternalRequestedData(key), timeoutMs);
  } catch (err) {
    console.warn("[FORWARDING][EXTERNAL] fetchExternalRecords error:", err?.message || err);
    return [];
  }
}

/**
 * Reusable display-only row merge:
 * - fetches external dataset once
 * - builds in-memory lookup by composite key
 * - merges mapped fields into response rows
 */
export async function mergeRowsWithExternalData(rows = [], config = {}) {
  if (!Array.isArray(rows) || !rows.length) return Array.isArray(rows) ? rows : [];

  const {
    requestedData,
    shouldMergeRow,
    buildRowKey,
    buildExternalKey = (rec) => normalizeKeyPart(rec?.uid) || null,
    mapExternalToRow = (rec) => ({
      uid: String(rec?.uid ?? "").trim() || null,
      billno: String(rec?.billno ?? "").trim() || null,
      billdt: String(rec?.billdt ?? "").trim() || null,
      status: String(rec?.status ?? "").trim() || null,
    }),
    emptyFields = { uid: null, billno: null, billdt: null, status: null },
    externalTimeoutMs = 2000,
  } = config;

  if (!requestedData || typeof buildRowKey !== "function") {
    return rows.map((row) => ({ ...row, ...emptyFields }));
  }

  const eligible = rows.filter((row) => (typeof shouldMergeRow === "function" ? shouldMergeRow(row) : true));
  if (!eligible.length) return rows.map((row) => ({ ...row, ...emptyFields }));

  const hasAnyKey = eligible.some((row) => Boolean(buildRowKey(row)));
  if (!hasAnyKey) return rows.map((row) => ({ ...row, ...emptyFields }));

  let externalRecords = [];
  try {
    externalRecords = await withTimeout(getExternalRequestedData(requestedData), externalTimeoutMs);
  } catch (err) {
    console.warn("[FORWARDING][EXTERNAL] mergeRowsWithExternalData error:", err?.message || err);
    externalRecords = [];
  }

  const lookup = new Map();
  for (const rec of externalRecords) {
    const key = buildExternalKey(rec);
    if (!key || lookup.has(key)) continue;
    lookup.set(key, rec);
  }

  return rows.map((row) => {
    if (typeof shouldMergeRow === "function" && !shouldMergeRow(row)) {
      return { ...row, ...emptyFields };
    }
    const rowKey = buildRowKey(row);
    if (!rowKey) return { ...row, ...emptyFields };
    const match = lookup.get(rowKey);
    if (!match) return { ...row, ...emptyFields };
    return { ...row, ...emptyFields, ...mapExternalToRow(match) };
  });
}
