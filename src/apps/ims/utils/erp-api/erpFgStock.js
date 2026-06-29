import { fetchImsDataRaw } from "../../services/ims.service.js";

function erpBalQty(record) {
  const n = Number(record?.BalQty ?? record?.balqty ?? record?.bal_qty ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function erpDocNo(record) {
  return String(record?.["Doc No."] ?? record?.doc_no ?? record?.docno ?? "").trim();
}

function erpDocDt(record) {
  const raw = record?.["Doc Dt"] ?? record?.doc_dt ?? record?.docdt ?? null;
  return raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;
}

/** Fetch ERP FG stock rows for one item (`requestedData: erpfg`). */
export async function fetchErpFgStockForItem(itemDcode) {
  const n = Number(itemDcode);
  if (!Number.isFinite(n) || n <= 0) {
    return { success: false, records: [], message: "Valid item_dcode is required." };
  }
  return fetchImsDataRaw("erpfg", n);
}

/** All ERP FG rows in one IMS call — use for reports (no per-item loop). */
const ERP_FG_CACHE_MS = Math.max(60_000, Number(process.env.ERP_FG_CACHE_MS) || 120_000);
let erpFgCache = null;
let erpFgCacheAt = 0;

export function invalidateErpFgStockCache() {
  erpFgCache = null;
  erpFgCacheAt = 0;
}

export async function fetchAllErpFgStock({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && erpFgCache && now - erpFgCacheAt < ERP_FG_CACHE_MS) {
    return erpFgCache;
  }
  const result = await fetchImsDataRaw("erpfg");
  if (Array.isArray(result?.records)) {
    erpFgCache = result;
    erpFgCacheAt = now;
  }
  return result;
}

/** Summarize ERP FG rows — total qty and qty keyed by packing/doc no. */
export function summarizeErpFgRecords(records = []) {
  const byPacking = new Map();
  const docDtByPacking = Object.create(null);
  let total = 0;
  const rows = Array.isArray(records) ? records : [];

  for (const rec of rows) {
    const bal = erpBalQty(rec);
    total += bal;
    const pn = erpDocNo(rec);
    if (pn) {
      byPacking.set(pn, (byPacking.get(pn) || 0) + bal);
      if (!docDtByPacking[pn]) docDtByPacking[pn] = erpDocDt(rec);
    }
  }

  return {
    total,
    byPacking: Object.fromEntries(byPacking),
    docDtByPacking,
    records: rows.map((rec) => ({
      itemdcode: rec?.itemdcode ?? rec?.item_dcode ?? null,
      doc_no: erpDocNo(rec),
      doc_dt: erpDocDt(rec),
      bal_qty: erpBalQty(rec),
    })),
  };
}

/** Group ERP FG records by item dcode — one bulk IMS response → Map for report merge. */
export function buildErpFgStockByItemMap(records = []) {
  const grouped = new Map();
  for (const rec of Array.isArray(records) ? records : []) {
    const dcode = String(rec?.itemdcode ?? rec?.item_dcode ?? "").trim();
    if (!dcode) continue;
    if (!grouped.has(dcode)) grouped.set(dcode, []);
    grouped.get(dcode).push(rec);
  }
  const byItem = new Map();
  for (const [dcode, recs] of grouped.entries()) {
    byItem.set(dcode, summarizeErpFgRecords(recs));
  }
  return byItem;
}
