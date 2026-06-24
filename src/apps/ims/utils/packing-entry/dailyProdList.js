/**
 * Daily production list (packing entry): IMS pack rows + local sticker DB merge + comparison.
 * Pending tab uses a fast path (no panel-meta / comparison). Generated loads panel meta lazily.
 */
import dbQuery from "../../../../config/db.js";
import { fetchFromIMS } from "../../services/ims.service.js";
import { getProductionStickerPanelMetaByPackingNumbers, getProductionStickerPackingDocNos } from "../../models/box.model.js";
import { pickProductionStickerPanelMeta } from "./productionStickerPanelMeta.js";
import { getImsMapsSafe, canonicalCode } from "../erp-api/imsLookup.js";
import { buildPartyRateAccNameMap, resolvePackingCustomerName } from "./packingEntryCustomers.js";
import { dailyProdListFieldsFromRow, dailyProdSnapshotCoreFields, storedPackingCustomerName, stickerFetchRowFromDailyProd, DAILYPROD_STICKER_EXTRA_SELECT } from "./stickerGenerateSnapshot.js";
import { sanitizeSearch } from "../../../core/utils/helper.js";
import { buildImsPackDocdtFilter, normalizePackingDocNo, packRowInYmdRange, parsePackRow, toCalendarDateKey, trimYmdFilter } from "./packRowParse.js";

const DAILYPROD_ROW_SELECT = `
            doc_dt::text AS doc_dt,
            job_card_no,
            acc_code::text AS acc_code,
            acc_name,
            item_dcode,
            item_code,
            total_qty,
            ${DAILYPROD_STICKER_EXTRA_SELECT}`;

const LIST_MAX_LIMIT = 100_000;
const GENERATED_DOC_NOS_TTL_MS = 60_000;
const PACK_LIST_CACHE_TTL_MS = Math.max(30_000, Number(process.env.IMS_PACK_LIST_CACHE_MS) || 60_000);

let generatedDocNosCache = null;
let generatedDocNosCacheAt = 0;
/** @type {Map<string, { at: number, records: unknown[] }>} */
const packListCache = new Map();

const EMPTY_PARTY_RATE_MAP = new Map();

async function fetchPackRecordsCached(imsPackFilter, bucket = "pending", forceRefresh = false) {
  const key = `${bucket}::${imsPackFilter}`;
  const now = Date.now();
  if (!forceRefresh) {
    const hit = packListCache.get(key);
    if (hit && now - hit.at < PACK_LIST_CACHE_TTL_MS) {
      return hit.records;
    }
  }
  const records = await fetchFromIMS("pack", imsPackFilter);
  packListCache.set(key, { at: now, records: records || [] });
  return records || [];
}

function wantsListRefresh(body = {}) {
  return body.refresh === true || body.refresh === "true" || body.filters?.refresh === true;
}

/** Comparison tab — mismatch rows only (customer field ignored). */
function hasComparisonMismatchForFilter(row) {
  if (row?.comparison?.missing_ims || row?.ims_missing) return true;
  const fields = row?.comparison?.fields || {};
  return Object.entries(fields).some(([key, f]) => {
    if (key === "acc_name") return false;
    return Boolean(f?.mismatch);
  });
}

function resolveStickerListMode(filters = {}, body = {}) {
  const s = String(filters?.sticker_status || "pending").toLowerCase();
  const hasSearch = Boolean(sanitizeSearch(body?.search));
  if (s === "comparison") return "comparison";
  if (s === "generated") return "generated";
  if (s === "all") return "full";
  if (hasSearch) return "full";
  return "pending";
}

function sliceList(rows, page = 1, limit) {
  const total = rows.length;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const parsed = parseInt(limit, 10);
  const effectiveLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : total || LIST_MAX_LIMIT;
  const safeLimit = Math.min(LIST_MAX_LIMIT, Math.max(1, effectiveLimit));
  const start = (safePage - 1) * safeLimit;
  return {
    data: rows.slice(start, start + safeLimit),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
}

function customerName(accCode, ledgerMap, partyRateMap, itemDcode, inlineName = null) {
  return resolvePackingCustomerName(accCode, { ledgerMap, partyRateMap, itemDcode, inlineName });
}

function panelAccCode(panel) {
  if (!panel) return null;
  if (panel.acc_code != null && String(panel.acc_code).trim() !== "-") return String(panel.acc_code).trim();
  if (panel.dailyprod_acc_code != null && String(panel.dailyprod_acc_code).trim() !== "") {
    return String(panel.dailyprod_acc_code).trim();
  }
  return null;
}

function normCompareText(v) {
  if (v == null) return "";
  return String(v).trim().toUpperCase();
}

function normCompareQty(v) {
  const n = parseFloat(String(v ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function compareField(imsVal, localVal, normalize) {
  const normIms = normalize(imsVal);
  const normLocal = normalize(localVal);
  return {
    ims: normIms || imsVal,
    local: normLocal || localVal,
    mismatch: normIms !== normLocal,
  };
}

function compareDateField(imsVal, localVal) {
  const imsKey = toCalendarDateKey(imsVal);
  const localKey = toCalendarDateKey(localVal);
  return {
    ims: imsKey || imsVal,
    local: localKey || localVal,
    mismatch: imsKey !== localKey && Boolean(imsKey || localKey),
  };
}

function compareCustomerField(imsRow, localRow, ledgerMap, partyRateMap) {
  const mismatch = normCompareText(imsRow?.acc_code) !== normCompareText(localRow?.acc_code);
  const imsItem = imsRow?.itemdcode ?? null;
  return {
    ims:
      customerName(imsRow?.acc_code, ledgerMap, partyRateMap, imsItem, imsRow?.acc_name) ||
      imsRow?.acc_code ||
      "",
    local: localRow?.acc_name || localRow?.acc_code || "",
    mismatch,
  };
}

function buildComparison(imsRow, localRow, ledgerMap, partyRateMap) {
  if (!imsRow || !localRow) return { has_mismatch: false, fields: {} };
  const fields = {
    doc_dt: compareDateField(imsRow.doc_dt, localRow.doc_dt),
    job_card_no: compareField(imsRow.job_card_no, localRow.job_card_no, normCompareText),
    acc_name: compareCustomerField(imsRow, localRow, ledgerMap, partyRateMap),
    item_code: compareField(imsRow.item_code, localRow.item_code, normCompareText),
    total_qty: compareField(imsRow.total_qty, localRow.total_qty, normCompareQty),
  };
  return { has_mismatch: Object.values(fields).some((f) => f.mismatch), fields };
}

function attachComparison(imsRow, localRow, stickerGenerated, ledgerMap, partyRateMap) {
  if (!stickerGenerated) {
    return {
      ims_source: imsRow,
      local_source: null,
      comparison: { has_mismatch: false, fields: {} },
      has_comparison_mismatch: false,
    };
  }
  if (!localRow) {
    return {
      ims_source: imsRow,
      local_source: null,
      comparison: { has_mismatch: true, fields: {}, missing_local: true },
      has_comparison_mismatch: true,
    };
  }
  const comparison = buildComparison(imsRow, localRow, ledgerMap, partyRateMap);
  return {
    ims_source: imsRow,
    local_source: localRow,
    comparison,
    has_comparison_mismatch: comparison.has_mismatch,
  };
}

function buildLocalSnapshot(dpRow, itemMap, ledgerMap, partyRateMap) {
  if (!dpRow) return null;
  const snapCore = dailyProdSnapshotCoreFields(dpRow);
  const itemDcode = dpRow.item_dcode ?? dpRow.itemdcode ?? snapCore.itemdcode ?? null;
  const itemDetail = itemDcode != null ? itemMap.get(canonicalCode(itemDcode)) : null;
  const accCode =
    dpRow.acc_code != null && String(dpRow.acc_code).trim() !== ""
      ? String(dpRow.acc_code).trim()
      : snapCore.acc_code != null
        ? String(snapCore.acc_code).trim()
        : null;
  const docDt = toCalendarDateKey(dpRow.doc_dt) || (snapCore.doc_dt ? toCalendarDateKey(snapCore.doc_dt) : null);
  return {
    doc_dt: docDt || null,
    job_card_no: dpRow.job_card_no ?? snapCore.job_card_no ?? null,
    acc_code: accCode,
    acc_name: storedPackingCustomerName(dpRow),
    itemdcode: itemDcode != null ? String(itemDcode) : null,
    item_code: dpRow.item_code ?? snapCore.item_code ?? itemDetail?.item_code ?? null,
    item_desc: dpRow.item_desc ?? itemDetail?.item_desc ?? null,
    total_qty:
      dpRow.total_qty != null && String(dpRow.total_qty).trim() !== ""
        ? String(dpRow.total_qty)
        : snapCore.total_qty ?? "0",
  };
}

function buildSnapshotFromPanel(panel, ledgerMap, partyRateMap) {
  const accCode = panelAccCode(panel);
  const itemDcode = panel?.itemdcode ?? panel?.item_dcode ?? null;
  return {
    doc_dt: panel?.dailyprod_doc_dt ? toCalendarDateKey(panel.dailyprod_doc_dt) : null,
    job_card_no: panel?.dailyprod_job_card_no ?? null,
    acc_code: accCode,
    acc_name: customerName(accCode, ledgerMap, partyRateMap, itemDcode),
    itemdcode: itemDcode,
    item_code: null,
    item_desc: null,
    total_qty:
      panel?.dailyprod_total_qty != null && panel?.dailyprod_total_qty !== ""
        ? String(panel.dailyprod_total_qty)
        : "0",
  };
}

function attachDbOnlyComparison(localRow) {
  return {
    ims_source: null,
    local_source: localRow,
    comparison: { has_mismatch: true, fields: {}, missing_ims: true },
    has_comparison_mismatch: true,
    ims_missing: true,
  };
}

function resolveDbDocDt(docKey, dailyprodByDoc, panelMetaMap) {
  const dp = dailyprodByDoc.get(docKey);
  if (dp?.doc_dt) return toCalendarDateKey(dp.doc_dt) || dp.doc_dt;
  const panel =
    pickProductionStickerPanelMeta(panelMetaMap, docKey, null, null) ?? panelMetaMap.get(docKey);
  if (panel?.dailyprod_doc_dt) return toCalendarDateKey(panel.dailyprod_doc_dt);
  return null;
}

function applyPanelMeta(row, panelMetaMap, dailyprodByDoc, itemMap, ledgerMap, partyRateMap) {
  const docKey = normalizePackingDocNo(row.doc_no);
  const panel =
    pickProductionStickerPanelMeta(panelMetaMap, row.doc_no, row.itemdcode, row.acc_code) ??
    (docKey ? panelMetaMap.get(docKey) : undefined);
  const next = { ...row };
  const itemDcode = next.itemdcode ?? panel?.itemdcode ?? panel?.item_dcode ?? null;
  const dpRow = docKey ? dailyprodByDoc.get(docKey) : null;

  if (row.sticker_generated && dpRow?.acc_code != null && String(dpRow.acc_code).trim() !== "") {
    const stickerCustomer = String(dpRow.acc_code).trim();
    next.acc_code = stickerCustomer;
    const savedName = storedPackingCustomerName(dpRow);
    if (savedName) next.acc_name = savedName;
  }

  if (row.sticker_generated && panel) {
    if (panel.itemdcode) {
      const itemDetail = itemMap.get(canonicalCode(panel.itemdcode));
      next.itemdcode = panel.itemdcode;
      next.item_code = itemDetail?.item_code ?? next.item_code;
      next.item_desc = itemDetail?.item_desc ?? next.item_desc;
    }
    if (panel.dailyprod_job_card_no) next.job_card_no = panel.dailyprod_job_card_no;
    if (panel.dailyprod_total_qty != null && panel.dailyprod_total_qty !== "") {
      next.total_qty = String(panel.dailyprod_total_qty);
    }
  }

  if (panel) {
    next.sticker_count = panel.sticker_count ?? null;
    next.sticker_created_at = panel.sticker_created_at ?? null;
    next.sticker_created_by_name = panel.sticker_created_by_name ?? null;
    next.sticker_updated_at = panel.sticker_updated_at ?? null;
    next.sticker_updated_by_name = panel.sticker_updated_by_name ?? null;
  }

  if (row.sticker_generated && dpRow) {
    Object.assign(next, dailyProdListFieldsFromRow(dpRow));
    const snapCore = dailyProdSnapshotCoreFields(dpRow);
    if (snapCore.doc_dt || dpRow.doc_dt) {
      next.doc_dt =
        (snapCore.doc_dt ? toCalendarDateKey(snapCore.doc_dt) : null) ||
        toCalendarDateKey(dpRow.doc_dt) ||
        dpRow.doc_dt;
    }
    if (snapCore.job_card_no ?? dpRow.job_card_no) {
      next.job_card_no = snapCore.job_card_no ?? dpRow.job_card_no;
    }
    if (snapCore.total_qty ?? dpRow.total_qty != null) {
      next.total_qty = String(snapCore.total_qty ?? dpRow.total_qty);
    }
    if (snapCore.item_code ?? dpRow.item_code) {
      next.item_code = snapCore.item_code ?? dpRow.item_code;
    }
    next._display_source = "db_columns";
  }

  return next;
}

function buildImsRow(p, itemMap, ledgerMap, partyRateMap) {
  const itemDetail = itemMap.get(canonicalCode(p.itemdcode));
  return {
    doc_no: p.doc_no,
    doc_dt: p.doc_dt,
    job_card_no: p.job_card_no,
    acc_code: p.acc_code,
    acc_name: customerName(p.acc_code, ledgerMap, partyRateMap, p.itemdcode, p.acc_name_row),
    itemdcode: p.itemdcode,
    item_code: p.item_code_row ?? itemDetail?.item_code ?? "N/A",
    item_desc: p.itemdesc_row ?? itemDetail?.item_desc ?? "N/A",
    total_qty: String(p.qty ?? "0"),
  };
}

/** Pending tab: IMS row + sticker flag only (no comparison / panel meta). */
function buildPendingRow(r, generatedMap, itemMap, ledgerMap, partyRateMap) {
  const p = parsePackRow(r);
  const docKey = normalizePackingDocNo(p.doc_no);
  return {
    ...buildImsRow(p, itemMap, ledgerMap, partyRateMap),
    sticker_generated: docKey ? generatedMap.has(docKey) : false,
  };
}

function buildFullRowFromImsRecord(r, ctx, withPanelMeta, { lean = false } = {}) {
  const { generatedMap, dailyprodByDoc, panelMetaMap, dailyprodAccByDoc, itemMap, ledgerMap, partyRateMap } =
    ctx;
  const p = parsePackRow(r);
  const docKey = normalizePackingDocNo(p.doc_no);
  const imsRow = buildImsRow(p, itemMap, ledgerMap, partyRateMap);
  const stickerGenerated = docKey ? generatedMap.has(docKey) : false;

  if (lean || !stickerGenerated) {
    return { ...imsRow, sticker_generated: stickerGenerated };
  }

  const localSnapshot = buildLocalSnapshot(dailyprodByDoc.get(docKey), itemMap, ledgerMap, partyRateMap);

  const base = {
    ...imsRow,
    sticker_generated: stickerGenerated,
    ...attachComparison(imsRow, localSnapshot, stickerGenerated, ledgerMap, partyRateMap),
  };

  return withPanelMeta
    ? applyPanelMeta(base, panelMetaMap, dailyprodByDoc, itemMap, ledgerMap, partyRateMap)
    : base;
}

function buildDbOnlyRow(docKey, ctx, withPanelMeta, { lean = false } = {}) {
  const { dailyprodByDoc, panelMetaMap, dailyprodAccByDoc, itemMap, ledgerMap, partyRateMap } = ctx;
  const dpRow = dailyprodByDoc.get(docKey);
  const panel =
    pickProductionStickerPanelMeta(panelMetaMap, docKey, null, null) ?? panelMetaMap.get(docKey);
  const localSnapshot =
    buildLocalSnapshot(dpRow, itemMap, ledgerMap, partyRateMap) ??
    (panel ? buildSnapshotFromPanel(panel, ledgerMap, partyRateMap) : null);

  const itemDcode = localSnapshot?.itemdcode ?? panel?.itemdcode ?? panel?.item_dcode ?? null;
  const itemDetail = itemDcode != null ? itemMap.get(canonicalCode(itemDcode)) : null;
  const accCode = localSnapshot?.acc_code ?? panelAccCode(panel);

  const base = {
    doc_no: docKey,
    doc_dt: localSnapshot?.doc_dt ?? null,
    job_card_no: localSnapshot?.job_card_no ?? null,
    acc_code: accCode,
    acc_name: customerName(accCode, ledgerMap, partyRateMap, itemDcode, localSnapshot?.acc_name),
    itemdcode: itemDcode,
    item_code: localSnapshot?.item_code ?? itemDetail?.item_code ?? "N/A",
    item_desc: localSnapshot?.item_desc ?? itemDetail?.item_desc ?? "N/A",
    total_qty: localSnapshot?.total_qty ?? "0",
    sticker_generated: true,
    ...(lean ? {} : attachDbOnlyComparison(localSnapshot)),
  };

  return withPanelMeta
    ? applyPanelMeta(base, panelMetaMap, dailyprodByDoc, itemMap, ledgerMap, partyRateMap)
    : base;
}

/** Generated list row from local DB only — no IMS pack / party-rate lookups. */
function buildGeneratedRowFromDp(dpRow, docKey) {
  const snapCore = dailyProdSnapshotCoreFields(dpRow);
  const fromSnap = stickerFetchRowFromDailyProd(dpRow);
  const listFields = dailyProdListFieldsFromRow(dpRow);
  const itemDesc = fromSnap?.itemdesc ?? fromSnap?.item_desc ?? dpRow?.item_desc ?? null;

  return {
    doc_no: docKey,
    doc_dt:
      toCalendarDateKey(fromSnap?.doc_dt) ||
      toCalendarDateKey(dpRow?.doc_dt) ||
      dpRow?.doc_dt ||
      null,
    job_card_no: fromSnap?.job_card_no ?? dpRow?.job_card_no ?? null,
    acc_code: fromSnap?.acc_code ?? dpRow?.acc_code ?? snapCore.acc_code ?? null,
    acc_name: storedPackingCustomerName(dpRow) ?? fromSnap?.acc_name ?? dpRow?.acc_name ?? null,
    itemdcode: fromSnap?.itemdcode ?? dpRow?.item_dcode ?? snapCore.itemdcode ?? null,
    item_code: fromSnap?.item_code ?? dpRow?.item_code ?? snapCore.item_code ?? "N/A",
    item_desc: itemDesc != null && String(itemDesc).trim() !== "" ? String(itemDesc).trim() : "N/A",
    total_qty: String(fromSnap?.total_qty ?? dpRow?.total_qty ?? snapCore.total_qty ?? "0"),
    sticker_generated: true,
    _display_source: "db_columns",
    ...listFields,
  };
}

function collectPackDocKeys(records) {
  const keys = new Set();
  for (const r of records || []) {
    const k = normalizePackingDocNo(parsePackRow(r).doc_no);
    if (k) keys.add(k);
  }
  return keys;
}

/** Sticker flags for packing numbers on the current IMS page only (avoids full-table scan). */
async function loadGeneratedDocNosForKeys(docKeys = []) {
  const keys = [...new Set([...docKeys].map((d) => normalizePackingDocNo(d)).filter(Boolean))];
  if (!keys.length) return new Set();

  const [dailyprodRows, boxRows] = await Promise.all([
    dbQuery(
      `SELECT trim(doc_no::text) AS doc_no
       FROM ims_dailyprod
       WHERE sticker_generated = true
         AND trim(doc_no::text) = ANY($1::text[])`,
      [keys]
    ),
    dbQuery(
      `SELECT DISTINCT trim(packing_number::text) AS doc_no
       FROM ims_box_table
       WHERE is_deleted = false
         AND trim(packing_number::text) = ANY($1::text[])
         AND NOT (sa_entry_type = 'stock_in' AND sa_id IS NOT NULL)`,
      [keys]
    ),
  ]);

  const generatedMap = new Set();
  for (const r of dailyprodRows || []) {
    const n = normalizePackingDocNo(r.doc_no);
    if (n) generatedMap.add(n);
  }
  for (const r of boxRows || []) {
    const n = normalizePackingDocNo(r.doc_no);
    if (n) generatedMap.add(n);
  }
  return generatedMap;
}

/** Lightweight set of packing numbers with generated stickers (cached ~60s). */
async function loadGeneratedDocNos(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && generatedDocNosCache && now - generatedDocNosCacheAt < GENERATED_DOC_NOS_TTL_MS) {
    return generatedDocNosCache;
  }

  const [dailyprodRows, packingWithStickers] = await Promise.all([
    dbQuery(`SELECT trim(doc_no::text) AS doc_no FROM ims_dailyprod WHERE sticker_generated = true`),
    getProductionStickerPackingDocNos(),
  ]);

  const generatedMap = new Set();
  for (const r of dailyprodRows || []) {
    const n = normalizePackingDocNo(r.doc_no);
    if (n) generatedMap.add(n);
  }
  for (const docNo of packingWithStickers || []) {
    const n = normalizePackingDocNo(docNo);
    if (n) generatedMap.add(n);
  }

  generatedDocNosCache = generatedMap;
  generatedDocNosCacheAt = now;
  return generatedMap;
}

function buildDailyprodMaps(rows) {
  const dailyprodByDoc = new Map();
  const dailyprodAccByDoc = new Map();
  for (const r of rows || []) {
    const key = normalizePackingDocNo(r.doc_no);
    if (!key) continue;
    dailyprodByDoc.set(key, r);
    const acc = r.acc_code != null ? String(r.acc_code).trim() : "";
    if (acc) dailyprodAccByDoc.set(key, acc);
  }
  return { dailyprodByDoc, dailyprodAccByDoc };
}

/** Generated tab: date-filtered dailyprod rows only (no IMS pack fetch). */
async function loadDailyprodSnapshotsInRange(fromYmd, toYmd) {
  const conditions = ["sticker_generated = true"];
  const values = [];
  let i = 1;
  if (fromYmd) {
    values.push(fromYmd);
    conditions.push(`doc_dt::date >= $${i++}::date`);
  }
  if (toYmd) {
    values.push(toYmd);
    conditions.push(`doc_dt::date <= $${i++}::date`);
  }
  const rows = await dbQuery(
    `SELECT trim(doc_no::text) AS doc_no,
            ${DAILYPROD_ROW_SELECT}
     FROM ims_dailyprod
     WHERE ${conditions.join(" AND ")}`,
    values
  );
  return buildDailyprodMaps(rows);
}

/** All dailyprod snapshots for generated packings (small query; panel meta is loaded lazily). */
async function loadDailyprodSnapshots() {
  const rows = await dbQuery(
    `SELECT trim(doc_no::text) AS doc_no,
            ${DAILYPROD_ROW_SELECT}
     FROM ims_dailyprod
     WHERE sticker_generated = true`
  );
  return buildDailyprodMaps(rows);
}

async function loadStickerContextForRange(fromYmd, toYmd, imsDocKeys = [], forceRefresh = false) {
  const snapshotMaps = await loadDailyprodSnapshotsInRange(fromYmd, toYmd);
  const scopedFromIms = await loadGeneratedDocNosForKeys([...imsDocKeys]);
  const generatedMap = new Set([...snapshotMaps.dailyprodByDoc.keys(), ...scopedFromIms]);
  return {
    generatedMap,
    dailyprodByDoc: snapshotMaps.dailyprodByDoc,
    dailyprodAccByDoc: snapshotMaps.dailyprodAccByDoc,
    panelMetaMap: new Map(),
  };
}

/** Panel meta + dailyprod snapshot for generated rows on the current page only (fast). */
async function loadDailyprodForDocKeys(docKeys = []) {
  const keys = [...new Set(docKeys.map((d) => normalizePackingDocNo(d)).filter(Boolean))];
  if (!keys.length) return new Map();
  const rows = await dbQuery(
    `SELECT trim(doc_no::text) AS doc_no,
            ${DAILYPROD_ROW_SELECT}
     FROM ims_dailyprod
     WHERE sticker_generated = true
       AND trim(doc_no::text) = ANY($1::text[])`,
    [keys]
  );
  return buildDailyprodMaps(rows).dailyprodByDoc;
}

async function enrichGeneratedRowsPage(rows, itemMap, ledgerMap, partyRateMap) {
  const keys = collectGeneratedDocKeys(rows);
  if (!keys.size) return rows;
  const dailyprodByDoc = await loadDailyprodForDocKeys([...keys]);
  const ctx = {
    panelMetaMap: new Map(),
    dailyprodByDoc,
    itemMap,
    ledgerMap,
    partyRateMap,
  };
  await hydratePanelMeta(ctx, keys);
  return applyPanelMetaToGeneratedRows(rows, ctx);
}

async function hydratePanelMeta(ctx, docKeys) {
  const list = docKeys instanceof Set ? [...docKeys] : Array.isArray(docKeys) ? docKeys : [];
  const nums = [...new Set(list.map((d) => normalizePackingDocNo(d)).filter(Boolean))];
  if (!nums.length) return;
  const fetched = await getProductionStickerPanelMetaByPackingNumbers(nums);
  for (const [k, v] of fetched) {
    if (!ctx.panelMetaMap.has(k)) ctx.panelMetaMap.set(k, v);
  }
}

function collectGeneratedDocKeys(rows) {
  const keys = new Set();
  for (const row of rows || []) {
    if (!row?.sticker_generated) continue;
    const k = normalizePackingDocNo(row.doc_no);
    if (k) keys.add(k);
  }
  return keys;
}

function appendDbOnlyRows(data, imsDocKeys, ctx, fromYmd, toYmd, withPanelMeta, lean = false) {
  const out = [...data];
  const docKeys = ctx.dailyprodByDoc?.size ? [...ctx.dailyprodByDoc.keys()] : [...ctx.generatedMap];
  for (const docKey of docKeys) {
    if (imsDocKeys.has(docKey)) continue;
    if (!packRowInYmdRange(resolveDbDocDt(docKey, ctx.dailyprodByDoc, ctx.panelMetaMap), fromYmd || null, toYmd || null)) {
      continue;
    }
    out.push(buildDbOnlyRow(docKey, ctx, withPanelMeta, { lean }));
  }
  return out;
}

function filterRows(rows, { acc_code, item_dcode, from_date, to_date, sticker_generated, search, dailyprodByDoc, panelMetaMap }) {
  let data = rows;

  if (acc_code != null && acc_code !== "") {
    data = data.filter((r) => String(r.acc_code) === String(acc_code));
  }
  if (item_dcode != null && item_dcode !== "") {
    data = data.filter((r) => String(r.itemdcode) === String(item_dcode));
  }

  const { from, to } = trimYmdFilter(from_date, to_date);
  if (from || to) {
    data = data.filter((r) => {
      const docKey = normalizePackingDocNo(r.doc_no);
      const docDt =
        r.sticker_generated && docKey
          ? resolveDbDocDt(docKey, dailyprodByDoc, panelMetaMap) || r.doc_dt
          : r.doc_dt;
      return packRowInYmdRange(docDt, from || null, to || null);
    });
  }

  if (sticker_generated !== undefined && sticker_generated !== "") {
    const want = sticker_generated === true || sticker_generated === "true";
    data = data.filter((r) => Boolean(r.sticker_generated) === want);
  }

  const s = sanitizeSearch(search);
  if (s) {
    const low = s.toLowerCase();
    data = data.filter((row) =>
      [row.doc_no, row.job_card_no, row.item_code, row.item_desc, row.acc_name, row.total_qty].some(
        (v) => v != null && String(v).toLowerCase().includes(low)
      )
    );
  }

  return data;
}

function sortRows(data, sortBy, order) {
  const sortKey = String(sortBy || "doc_dt").toLowerCase();
  const mul = String(order || "DESC").toUpperCase() === "ASC" ? 1 : -1;
  data.sort((a, b) => {
    const va = a[sortKey] == null ? "" : String(a[sortKey]).toLowerCase();
    const vb = b[sortKey] == null ? "" : String(b[sortKey]).toLowerCase();
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return 0;
  });
  return data;
}

function refreshRowComparison(row, ledgerMap, partyRateMap, dailyprodByDoc, itemMap) {
  if (!row?.sticker_generated || !row?.ims_source) return row;
  if (row.comparison?.missing_ims || row.comparison?.missing_local) return row;
  const docKey = normalizePackingDocNo(row.doc_no);
  const dpRow = docKey && dailyprodByDoc ? dailyprodByDoc.get(docKey) : null;
  const localRow =
    dpRow && itemMap
      ? buildLocalSnapshot(dpRow, itemMap, ledgerMap, partyRateMap)
      : row.local_source;
  if (!localRow) return row;
  const comparison = buildComparison(row.ims_source, localRow, ledgerMap, partyRateMap);
  return {
    ...row,
    local_source: localRow,
    comparison,
    has_comparison_mismatch: comparison.has_mismatch,
  };
}

async function applyPanelMetaToGeneratedRows(rows, ctx) {
  const keys = collectGeneratedDocKeys(rows);
  if (!keys.size) return rows;
  await hydratePanelMeta(ctx, keys);
  return rows.map((row) => {
    if (!row.sticker_generated) return row;
    const withMeta = applyPanelMeta(
      row,
      ctx.panelMetaMap,
      ctx.dailyprodByDoc,
      ctx.itemMap,
      ctx.ledgerMap,
      ctx.partyRateMap
    );
    return refreshRowComparison(withMeta, ctx.ledgerMap, ctx.partyRateMap, ctx.dailyprodByDoc, ctx.itemMap);
  });
}

function wantsPendingOnly(sticker_generated) {
  return sticker_generated === false || sticker_generated === "false";
}

async function buildPendingList(body, defaultSpanDays) {
  const { search, page, limit, sortBy, order, filters = {} } = body;
  const { acc_code, item_dcode, from_date, to_date, sticker_generated } = filters;
  const forceRefresh = wantsListRefresh(body);
  const imsPackFilter = buildImsPackDocdtFilter({ from_date, to_date }, defaultSpanDays);
  const pendingOnly = wantsPendingOnly(sticker_generated);

  const [{ itemMap, ledgerMap }, records] = await Promise.all([
    getImsMapsSafe(),
    fetchPackRecordsCached(imsPackFilter, "pending", forceRefresh),
  ]);

  if (!records?.length) {
    return { data: [], total: 0, page: 1, limit: limit || 50, totalPages: 1 };
  }

  const generatedMap = await loadGeneratedDocNosForKeys(collectPackDocKeys(records));

  let data = [];
  for (const r of records) {
    const p = parsePackRow(r);
    const docKey = normalizePackingDocNo(p.doc_no);
    const isGenerated = docKey ? generatedMap.has(docKey) : false;

    if (pendingOnly && isGenerated) continue;

    data.push({
      ...buildImsRow(p, itemMap, ledgerMap, EMPTY_PARTY_RATE_MAP),
      sticker_generated: isGenerated,
    });
  }

  if (acc_code || item_dcode || search) {
    data = filterRows(data, {
      acc_code,
      item_dcode,
      from_date,
      to_date,
      sticker_generated,
      search,
      dailyprodByDoc: new Map(),
      panelMetaMap: new Map(),
    });
  }

  sortRows(data, sortBy, order);
  const sliced = sliceList(data, page, limit);
  sliced.data = await enrichGeneratedRowsPage(sliced.data, itemMap, ledgerMap, EMPTY_PARTY_RATE_MAP);
  return sliced;
}

/** Generated tab — DB snapshot only: no IMS pack / party-rate fetch. */
async function buildGeneratedList(body) {
  const { search, page, limit, sortBy, order, filters = {} } = body;
  const { acc_code, item_dcode, from_date, to_date } = filters;
  const { from, to } = trimYmdFilter(from_date, to_date);

  const conditions = ["sticker_generated = true"];
  const values = [];
  let i = 1;

  if (from) {
    values.push(from);
    conditions.push(`doc_dt::date >= $${i++}::date`);
  }
  if (to) {
    values.push(to);
    conditions.push(`doc_dt::date <= $${i++}::date`);
  }
  if (acc_code != null && acc_code !== "") {
    values.push(acc_code);
    conditions.push(`acc_code = $${i++}`);
  }
  if (item_dcode != null && item_dcode !== "") {
    values.push(item_dcode);
    conditions.push(`item_dcode = $${i++}`);
  }

  if (search) {
    const s = `%${sanitizeSearch(search)}%`;
    values.push(s);
    const idx = i++;
    conditions.push(`(
      doc_no::text ILIKE $${idx} OR
      job_card_no ILIKE $${idx} OR
      item_code ILIKE $${idx} OR
      item_desc ILIKE $${idx} OR
      acc_name ILIKE $${idx}
    )`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const countRes = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM ims_dailyprod ${whereClause}`,
    values
  );
  const total = countRes[0]?.count || 0;

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (safePage - 1) * safeLimit;

  const allowedSort = ["doc_no", "doc_dt", "job_card_no", "total_qty", "acc_name", "item_code"];
  const sortKey = allowedSort.includes(sortBy) ? sortBy : "doc_dt";
  const sortOrder = ["ASC", "DESC"].includes(order?.toUpperCase()) ? order.toUpperCase() : "DESC";

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT trim(doc_no::text) AS doc_no,
            ${DAILYPROD_ROW_SELECT}
     FROM ims_dailyprod
     ${whereClause}
     ORDER BY ${sortKey} ${sortOrder}, doc_no DESC
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  const data = rows.map((dpRow) => buildGeneratedRowFromDp(dpRow, dpRow.doc_no));

  const ctx = {
    panelMetaMap: new Map(),
    dailyprodByDoc: new Map(data.map(r => [r.doc_no, r])),
    itemMap: new Map(),
    ledgerMap: new Map(),
    partyRateMap: EMPTY_PARTY_RATE_MAP,
  };

  const enriched = await applyPanelMetaToGeneratedRows(data, ctx);

  return {
    data: enriched,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
}

async function buildFullList(body, defaultSpanDays) {
  const { search, page, limit, sortBy, order, filters = {} } = body;
  const { acc_code, item_dcode, from_date, to_date, sticker_generated } = filters;
  const forceRefresh = wantsListRefresh(body);
  const { from, to } = trimYmdFilter(from_date, to_date);
  const imsPackFilter = buildImsPackDocdtFilter({ from_date, to_date }, defaultSpanDays);
  const listMode = String(filters?.sticker_status || "").toLowerCase();
  const isComparison = listMode === "comparison";
  const leanList = Boolean(body.list_view) && !isComparison;

  const [{ itemMap, ledgerMap }, partyRateMap, records] = await Promise.all([
    getImsMapsSafe(),
    isComparison ? buildPartyRateAccNameMap() : Promise.resolve(EMPTY_PARTY_RATE_MAP),
    fetchPackRecordsCached(imsPackFilter, "full", forceRefresh),
  ]);

  const imsDocKeys = collectPackDocKeys(records);
  const dbCtx = await loadStickerContextForRange(from, to, imsDocKeys, forceRefresh);
  const ctx = { ...dbCtx, itemMap, ledgerMap, partyRateMap };

  let recordsToMap = records || [];
  if (isComparison) {
    recordsToMap = recordsToMap.filter((r) => {
      const docKey = normalizePackingDocNo(parsePackRow(r).doc_no);
      return docKey && ctx.generatedMap.has(docKey);
    });
  }

  const imsDocKeySet = new Set();
  let data = recordsToMap.map((r) => {
    const docKey = normalizePackingDocNo(parsePackRow(r).doc_no);
    if (docKey) imsDocKeySet.add(docKey);
    return buildFullRowFromImsRecord(r, ctx, false, { lean: leanList });
  });

  data = appendDbOnlyRows(data, imsDocKeySet, ctx, from, to, false, leanList);
  data = filterRows(data, {
    acc_code,
    item_dcode,
    from_date,
    to_date,
    sticker_generated,
    search,
    dailyprodByDoc: dbCtx.dailyprodByDoc,
    panelMetaMap: dbCtx.panelMetaMap,
  });
  if (isComparison) {
    data = data.filter((row) => row.sticker_generated && hasComparisonMismatchForFilter(row));
  }
  sortRows(data, sortBy, order);
  const sliced = sliceList(data, page, limit);
  sliced.data = await enrichGeneratedRowsPage(sliced.data, itemMap, ledgerMap, partyRateMap);
  return sliced;
}

/** Build paginated daily-prod list payload for `/master/daily-prod/list`. */
export async function buildDailyProdList(body = {}, defaultSpanDays = 7) {
  const mode = resolveStickerListMode(body.filters, body);
  if (mode === "generated") {
    return buildGeneratedList(body);
  }
  if (mode === "comparison" || mode === "full") {
    return buildFullList(body, defaultSpanDays);
  }
  return buildPendingList(body, defaultSpanDays);
}

/** Call after sticker create/remove so the next list sees fresh flags. */
export function invalidateDailyProdGeneratedCache() {
  generatedDocNosCache = null;
  generatedDocNosCacheAt = 0;
  packListCache.clear();
}
