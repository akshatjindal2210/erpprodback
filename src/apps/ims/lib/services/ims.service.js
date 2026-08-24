import fetch from "node-fetch";
import config from "../../../../config/app/config.js";
import { noteImsIssue } from "../utils/erp-api/lookup/imsMeta.js";
import { normalizeDocDtForDb } from "../utils/packing-entry/parse/packRowParse.js";

function imsFailureMessage(err) {
  const m = err?.cause?.message || err?.message || String(err);
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|fetch failed|aborted|socket hang up|ECONNRESET|EPIPE/i.test(m)) {
    return "IMS ERP server unreachable. Check that the IMS service is running and ERP_IMS_API_URL is correct.";
  }
  return m;
}

function normalizeImsFilter(filter) {
  if (filter == null) return undefined;
  if (typeof filter === "object" && !Array.isArray(filter)) return filter;
  const trimmed = String(filter).trim();
  if (trimmed === "") return undefined;
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && String(asNum) === trimmed) return asNum;
  return trimmed;
}

async function imsPostJsonBody(requestedData, filter, timeoutMs) {
  const controller = new AbortController();
  const waitMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : (config.erpInternalApi.timeoutMs || 15000);
  const timer = setTimeout(() => controller.abort(), waitMs);
  const normalizedFilter = normalizeImsFilter(filter);
  try {
    const response = await fetch(config.erpInternalApi.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestedData,
        ...(normalizedFilter != null ? { filter: normalizedFilter } : {}),
      }),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text || !String(text).trim()) {
    return { ok: response.ok, json: {} };
  }
  try {
    return { ok: response.ok, json: JSON.parse(text) };
  } catch {
    return { ok: response.ok, json: { success: false, message: "IMS returned non-JSON response" } };
  }
}

/**
 * @param {string} requestedData - IMS dataset key (e.g. "pack")
 * @param {string} [filter] - optional SQL-style filter string (e.g. `dailyprod.docdt >= '2Apr2026' and dailyprod.docdt <= '6Apr2026'`)
 * @returns {Promise<any[]>} IMS `records` array, or **[]** if IMS is down / error (does not throw).
 */
export const fetchFromIMS = async (requestedData, filter = null, options = {}) => {
  try {
    const response = await imsPostJsonBody(requestedData, filter, options?.timeoutMs);
    const { json } = await readJsonResponse(response);
    if (!json || typeof json !== "object") {
      noteImsIssue("IMS returned an invalid response.");
      return [];
    }
    if (!json.success) {
      if (json.message) console.warn("[IMS]", requestedData, json.message);
      noteImsIssue(json.message || `IMS "${requestedData}" reported failure.`);
      return [];
    }
    const rec = json.records;
    if (Array.isArray(rec)) return rec;
    if (rec != null && typeof rec === "object") return [rec];
    return [];
  } catch (err) {
    const msg = imsFailureMessage(err);
    console.warn("[IMS] fetchFromIMS:", requestedData, msg);
    noteImsIssue(msg);
    return [];
  }
};

/** Full IMS JSON (`success`, `records`, `message`) — never throws; network/HTML errors become `{ success: false, records: [] }`. */
export const fetchImsDataRaw = async (requestedData, filter = null, options = {}) => {
  try {
    const response = await imsPostJsonBody(requestedData, filter, options?.timeoutMs);
    const { ok, json } = await readJsonResponse(response);
    if (!json || typeof json !== "object") {
      noteImsIssue("IMS returned an invalid response.");
      return { success: false, records: [], message: "Invalid IMS response" };
    }
    if (!ok) {
      const message = json.message || `IMS HTTP ${response.status}`;
      const records = Array.isArray(json.records) ? json.records : [];
      // Only flag global IMS meta when nothing usable came back.
      if (!records.length) noteImsIssue(message);
      return {
        success: false,
        records,
        message,
      };
    }
    if (!json.success) {
      const records = Array.isArray(json.records) ? json.records : [];
      if (!records.length) {
        noteImsIssue(json.message || `IMS "${requestedData}" reported failure.`);
      }
    }
    return json;
  } catch (err) {
    const message = imsFailureMessage(err);
    console.warn("[IMS] fetchImsDataRaw:", requestedData, message);
    noteImsIssue(message);
    return { success: false, records: [], message };
  }
};


const IMS_PACK_DOC_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatImsPackDocdtToken(d) {
  return `${d.getDate()}${IMS_PACK_DOC_MON[d.getMonth()]}${d.getFullYear()}`;
}

/** Indian FY "2025-2026" → 1 Apr 2025 … 31 Mar 2026 */
export function parseIndianFinancialYearBounds(fyStr) {
  const m = String(fyStr ?? "")
    .trim()
    .match(/^(\d{4})-(\d{4})$/);
  if (!m) throw new Error("Invalid financial year (expected e.g. 2025-2026)");
  const y1 = parseInt(m[1], 10);
  const y2 = parseInt(m[2], 10);
  if (!Number.isFinite(y1) || !Number.isFinite(y2) || y2 !== y1 + 1) {
    throw new Error("Invalid financial year range");
  }
  const from = new Date(y1, 3, 1);
  const to = new Date(y2, 2, 31);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  return { from, to };
}

/** Same shape as IMS examples: `dailyprod.docdt >= '2Apr2026' and … and dailyprod.docno = 30637` */
export function buildImsPackFilterForFinancialYearDocno(financialYear, docNo) {
  const { from, to } = parseIndianFinancialYearBounds(financialYear);
  const a = formatImsPackDocdtToken(from);
  const b = formatImsPackDocdtToken(to);
  const datePart = `dailyprod.docdt >= '${a}' and dailyprod.docdt <= '${b}'`;
  const n = parseInt(String(docNo).trim(), 10);
  const docClause = Number.isFinite(n)
    ? `dailyprod.docno = ${n}`
    : `dailyprod.docno = '${String(docNo).replace(/'/g, "''")}'`;
  return `${datePart} and ${docClause}`;
}

/** True if row `doc_dt` (YYYY-MM-DD) falls in Indian FY `fyStr` (e.g. 2025-2026). */
export function rowInIndianFinancialYear(row, fyStr) {
  const iso = row?.doc_dt;
  if (iso == null || String(iso).trim() === "") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) return false;
  const rowT = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)).getTime();
  let from;
  let to;
  try {
    ({ from, to } = parseIndianFinancialYearBounds(fyStr));
  } catch {
    return false;
  }
  return rowT >= from.getTime() && rowT <= to.getTime();
}

export function normalizeImsPackRow(r) {
  const docno = r.docno ?? r.doc_no ?? r.Doc_No ?? r["Doc No"] ?? r.DocNo;
  const rawDate = r.docdt ?? r.doc_dt ?? r.Doc_Dt ?? r["Doc Dt"] ?? r.DocDt;
  const itemdcode = r.itemdcode ?? r.ItemDcode ?? r.Itemdcode;
  const acc_code = r.acc_code ?? r.Acc_Code ?? r.AccCode;
  const jobcardno = r.jobcardno ?? r.job_card_no ?? r.Job_Card_No ?? r["Job Card No"] ?? r.JobCardNo;
  const acc_name = r.acc_name ?? r.Acc_Name ?? r.AccName;
  const item_code = r.item_code ?? r.Item_Code ?? r.ItemCode;
  const itemdesc = r.itemdesc ?? r.ItemDesc ?? r.item_desc;
  const qtyRaw = r.QTY ?? r.qty ?? r.Total_Qty ?? r.TotalQty ?? r.total_qty;
  const QTY = qtyRaw != null && qtyRaw !== "" ? Number(qtyRaw) : null;
  const doc_dt = normalizeDocDtForDb(rawDate);
  return {
    docno,
    docdt: rawDate != null ? String(rawDate) : null,
    doc_dt: doc_dt,
    jobcardno,
    acc_code,
    acc_name,
    itemdcode,
    item_code,
    itemdesc,
    QTY,
  };
}

/**
 * IMS `pack` with **strict** Indian FY + doc no only (no docno-only fallback — wrong FY data never returned).
 * Rows with parseable `doc_dt` outside the selected FY are dropped as a safety net.
 */
export async function fetchPackRowsForFinancialYearDoc(financialYear, docNo) {
  const filter = buildImsPackFilterForFinancialYearDocno(financialYear, docNo);
  const json = await fetchImsDataRaw("pack", filter);
  if (!json || typeof json !== "object") {
    return { success: false, records: [], message: "Invalid IMS response", filter };
  }
  if (!json.success) {
    return {
      success: false,
      records: [],
      message: json.message || "IMS API failed",
      filter,
    };
  }
  const raw = Array.isArray(json.records) ? json.records : [];
  let records = raw.map(normalizeImsPackRow);
  const imsMetaMessage = json.message && String(json.message).trim() !== "" ? String(json.message).trim() : null;

  records = records.filter((r) => !r.doc_dt || rowInIndianFinancialYear(r, financialYear));

  if (records.length > 0) {
    return {
      success: true,
      records,
      message: imsMetaMessage || "Data loaded.",
      filter,
    };
  }

  if (raw.length > 0 && records.length === 0) {
    return {
      success: false,
      records: [],
      message:
        "IMS returned a packing record, but the document date is outside the selected financial year. Choose the correct financial year.",
      filter,
      softMessage: true
    };
  }

  return {
    success: false,
    records: [],
    message:
      "No pack row was found in IMS for this financial year and packing number. Check the financial year, packing number, and spelling.",
    filter,
    softMessage: true
  };
}

/**
 * MRN ERP date column for IMS `mrn_rm` filter.
 * Shape: `m.mrndt >= '2Apr2020' and m.mrndt <= '6Apr2026'`
 */
export const IMS_MRN_MRNDT_COL = "m.mrndt";

/** Parse list filter date (`YYYY-MM-DD` / ISO / Date) → local calendar Date, or null. */
function coerceImsFilterDate(input, { endOfDay = false } = {}) {
  if (input == null || input === "") return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    const d = new Date(input.getTime());
    d.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return d;
  }
  const s = String(input).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return d;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Build IMS filter for `mrn_rm` when a date range is applied.
 * No dates → null (payload is only `{ requestedData: "mrn_rm" }`).
 */
export function buildImsMrnRmDateFilter(fromInput, toInput) {
  const from = coerceImsFilterDate(fromInput, { endOfDay: false });
  const to = coerceImsFilterDate(toInput, { endOfDay: true });
  if (!from && !to) return null;
  const parts = [];
  if (from) parts.push(`${IMS_MRN_MRNDT_COL} >= '${formatImsPackDocdtToken(from)}'`);
  if (to) parts.push(`${IMS_MRN_MRNDT_COL} <= '${formatImsPackDocdtToken(to)}'`);
  return parts.join(" and ");
}

/** IMS `mrn_rm` for FY — ERP gets `m.mrndt` filter; optional MRN no / UID matched in-app. */
export async function fetchMrnRowsForFinancialYear(financialYear, options = {}) {
  const fy = String(financialYear ?? "").trim();
  if (!fy) return { success: false, records: [], message: "Financial year is required." };

  const key = String(options.search ?? options.mrn_no ?? options.uid ?? "").trim();
  const { from, to } = parseIndianFinancialYearBounds(fy);
  const filter = buildImsMrnRmDateFilter(from, to);

  const json = await fetchImsDataRaw("mrn_rm", filter);
  if (!json?.success) {
    return { success: false, records: [], message: json?.message || "IMS API failed", filter };
  }

  let records = Array.isArray(json.records) ? json.records : [];
  if (key) {
    records = records.filter((r) => {
      const uid = String(r.uid ?? "").trim();
      const mrnno = String(r.mrnno ?? r.mrn_no ?? "").trim();
      return uid === key || mrnno === key;
    });
  }

  if (!records.length) {
    return {
      success: false,
      records: [],
      message: key ? `No MRN was found in FY ${fy} for "${key}".` : `No MRN rows were found in IMS for FY ${fy}.`,
      filter,
      softMessage: true,
    };
  }

  return { success: true, records, message: "MRN data loaded.", filter };
}
