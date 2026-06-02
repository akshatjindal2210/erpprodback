import { findDailyProdByDocNo, findLatestApprovedStandardQtyForItem, findStandardQtyPerBoxForPackingNumber, findInHandBoxesByPackingNumber } from "../models/box.model.js";
import { findFinancialYearForPacking, findFinancialYearForSaId } from "../models/stockAdjustment.model.js";
import { fetchFromIMS, fetchPackRowsForFinancialYearDoc, rowInIndianFinancialYear } from "../services/ims.service.js";
import { buildImsDocFilter, findImsPackByDocNo, imsPackRowToProduction } from "./imsPackRow.js";
import { enrichRowsWithIMS, getImsMapsSafe, getImsPartyRateMapSafe, pickPartyRateCustCode, partyRateAccCandidates } from "./imsLookup.js";

const SA_PACKING_META_CACHE = new Map();
const SA_PACKING_META_TTL_MS = 90_000;
let saImsMapsCache = null;
let saImsMapsCacheAt = 0;
let saPartyRateCache = null;
let saPartyRateCacheAt = 0;
const SA_IMS_MAPS_TTL_MS = 120_000;

function packingMetaCacheKey(pn, options) {
  return [
    pn,
    options.adjustment_id ?? "",
    options.item_dcode ?? "",
    options.financial_year ?? "",
  ].join("|");
}

async function getSaImsMapsCached() {
  if (saImsMapsCache && Date.now() - saImsMapsCacheAt < SA_IMS_MAPS_TTL_MS) {
    return saImsMapsCache;
  }
  saImsMapsCache = await getImsMapsSafe();
  saImsMapsCacheAt = Date.now();
  return saImsMapsCache;
}

async function getSaPartyRateMapCached() {
  if (saPartyRateCache && Date.now() - saPartyRateCacheAt < SA_IMS_MAPS_TTL_MS) {
    return saPartyRateCache;
  }
  saPartyRateCache = await getImsPartyRateMapSafe();
  saPartyRateCacheAt = Date.now();
  return saPartyRateCache;
}

function partyRateFromMap(map, { itemdcode, item_code, acc_code }) {
  const cands = partyRateAccCandidates(acc_code);
  return (
    pickPartyRateCustCode(map, itemdcode, cands) ||
    pickPartyRateCustCode(map, item_code, cands) ||
    null
  );
}
import { normalizeBoxNoUidPrefix } from "../../../global/boxUid.js";

/*
 Stock adjustment (add): sticker-style box id.
  {string|number} packingNumber — doc / packing no
  {string|number} saToken — adjustment id, or "?" for preview before save
  {number} totalBoxes
  {number} boxIndex — 1-based
*/

/** Last numeric segment of `{packing}_SA{id}_{total}_{index}` (box index). */
export function parseStockAdjustmentBoxIndex(boxNoUid) {
  const parts = String(boxNoUid ?? "").trim().split("_");
  const last = parseInt(parts[parts.length - 1], 10);
  return Number.isFinite(last) && last > 0 ? last : 0;
}

export function formatStockAdjustmentBoxNoUid(packingNumber, saToken, totalBoxes, boxIndex, prefix = "") {
  const pn = String(packingNumber ?? "").trim();
  const tok = saToken === "?" || saToken === "preview" ? "?" : String(saToken);
  const tb = parseInt(String(totalBoxes), 10);
  const bi = parseInt(String(boxIndex), 10);
  if (!pn || !Number.isFinite(tb) || tb < 1 || !Number.isFinite(bi) || bi < 1) return "";
  const core = `${pn}_SA${tok}_${tb}_${bi}`;
  const pfx = normalizeBoxNoUidPrefix(prefix);
  return pfx ? `${pfx}_${core}` : core;
}

//  True when per-box qty is below packing standard (treat as loose).
export function isLooseBoxComparedToStandard(perBoxQty, standardQtyPerBox) {
  const p = parseInt(String(perBoxQty ?? ""), 10);
  const s = parseInt(String(standardQtyPerBox ?? ""), 10);
  return Number.isFinite(p) && p > 0 && Number.isFinite(s) && s > 0 && p < s;
}

// Standard pcs/box for UI or inserts: linked `ims_dailyprod` standard first, else latest approved for item.
export async function resolveStandardQtyPerBoxForPacking({ packingNumber, itemDcode }) {
  const doc = packingNumber != null ? String(packingNumber).trim() : "";
  if (!doc) return null;
  const fromDoc = await findStandardQtyPerBoxForPackingNumber(doc);
  if (fromDoc != null) return fromDoc;
  return findLatestApprovedStandardQtyForItem(itemDcode);
}

/** Customer acc_code for SA boxes / stickers — dailyprod, in-hand boxes, then IMS pack row. */
export async function resolveOverrideCustForPacking(packingNumber, options = {}) {
  const pn = String(packingNumber ?? "").trim();
  if (!pn) return null;
  const dp =
    options.dailyProd !== undefined
      ? options.dailyProd
      : await findDailyProdByDocNo(pn);
  if (dp?.acc_code != null && String(dp.acc_code).trim() !== "") {
    return String(dp.acc_code).trim();
  }
  const boxes = await findInHandBoxesByPackingNumber(pn);
  for (const b of boxes || []) {
    const oc = b?.override_cust;
    if (oc != null && String(oc).trim() !== "") return String(oc).trim();
  }
  const fy = options?.financialYear != null ? String(options.financialYear).trim() : "";
  if (fy) {
    try {
      const ims = await fetchPackRowsForFinancialYearDoc(fy, pn);
      const first =
        (ims?.records || []).find((r) => rowInIndianFinancialYear(r, fy)) ?? ims?.records?.[0];
      const acc = first?.acc_code ?? first?.Acc_Code;
      if (acc != null && String(acc).trim() !== "") return String(acc).trim();
    } catch {
      /* optional IMS */
    }
  }
  return null;
}

/**
 * Item / customer / JC for SA drawer (add & minus) — uses stock_adjustment permission, not packing_entry.
 */
export async function resolveStockAdjustmentPackingMeta(packing_number, options = {}) {
  const pn = String(packing_number ?? "").trim();
  if (!pn) return null;

  const cacheKey = packingMetaCacheKey(pn, options);
  const cached = SA_PACKING_META_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < SA_PACKING_META_TTL_MS) {
    return cached.data;
  }

  const adjustmentId =
    options.adjustment_id != null && Number(options.adjustment_id) > 0
      ? Number(options.adjustment_id)
      : null;
  const itemFromAdj =
    options.item_dcode != null && String(options.item_dcode).trim() !== ""
      ? parseInt(String(options.item_dcode), 10)
      : null;
  const fyOpt =
    options.financial_year != null && String(options.financial_year).trim() !== ""
      ? String(options.financial_year).trim()
      : null;

  const [dp, fyFromSa, fyFromPack] = await Promise.all([
    findDailyProdByDocNo(pn),
    adjustmentId ? findFinancialYearForSaId(adjustmentId) : Promise.resolve(null),
    fyOpt ? Promise.resolve(null) : findFinancialYearForPacking(pn),
  ]);

  let itemdcode =
    dp?.itemdcode ?? (Number.isFinite(itemFromAdj) ? itemFromAdj : null);
  let acc_code = dp?.acc_code != null ? String(dp.acc_code).trim() : null;
  let job_card_no = dp?.job_card_no ?? null;
  let total_qty = dp?.total_qty ?? null;
  let doc_dt = dp?.doc_dt ?? null;

  const fy = fyOpt || fyFromSa || fyFromPack || null;

  const needsAccFromBoxes = !acc_code;
  const needsImsPackRow = !itemdcode || !acc_code;

  const [accFromOverride, imsFy, imsFilterProd] = await Promise.all([
    needsAccFromBoxes
      ? resolveOverrideCustForPacking(pn, { financialYear: fy, dailyProd: dp })
      : Promise.resolve(null),
    fy
      ? fetchPackRowsForFinancialYearDoc(fy, pn).catch(() => null)
      : Promise.resolve(null),
    needsImsPackRow
      ? (async () => {
          try {
            const filter = buildImsDocFilter(pn);
            const recs = filter ? await fetchFromIMS("pack", filter) : [];
            return imsPackRowToProduction(findImsPackByDocNo(recs, pn));
          } catch {
            return null;
          }
        })()
      : Promise.resolve(null),
  ]);

  if (!acc_code && accFromOverride) acc_code = accFromOverride;

  if (imsFy?.records?.length) {
    const first =
      imsFy.records.find((r) => rowInIndianFinancialYear(r, fy)) ?? imsFy.records[0];
    if (first) {
      itemdcode = itemdcode ?? first.itemdcode ?? first.ItemDcode ?? null;
      const acc = first.acc_code ?? first.Acc_Code;
      if (acc != null && String(acc).trim() !== "") acc_code = String(acc).trim();
      job_card_no = job_card_no ?? first.jobcardno ?? first.job_card_no ?? null;
      if (first.QTY != null) total_qty = String(first.QTY);
      doc_dt = doc_dt ?? first.doc_dt ?? first.docdt ?? null;
    }
  }

  if (imsFilterProd) {
    itemdcode = itemdcode ?? imsFilterProd.itemdcode ?? null;
    if (imsFilterProd.acc_code != null && String(imsFilterProd.acc_code).trim() !== "") {
      acc_code = String(imsFilterProd.acc_code).trim();
    }
    job_card_no = job_card_no ?? imsFilterProd.job_card_no ?? null;
    total_qty = total_qty ?? imsFilterProd.total_qty ?? null;
    doc_dt = doc_dt ?? imsFilterProd.doc_dt ?? null;
  }

  const effItemPre = itemdcode;
  const imsMapsPromise = getSaImsMapsCached();

  const [enrichedRows, standard_qty_per_box, partyRateMap] = await Promise.all([
    imsMapsPromise.then((maps) =>
      enrichRowsWithIMS([{ itemdcode, item_dcode: itemdcode, acc_code }], {
        itemCodeField: "itemdcode",
        accCodeField: "acc_code",
        itemCodeOut: "item_code",
        itemDescOut: "item_desc",
        accNameOut: "acc_name",
        maps,
      })
    ),
    resolveStandardQtyPerBoxForPacking({
      packingNumber: pn,
      itemDcode: effItemPre,
    }),
    getSaPartyRateMapCached(),
  ]);

  const enriched = enrichedRows?.[0];
  const effAcc = enriched?.acc_code ?? acc_code;
  const effItem = enriched?.itemdcode ?? itemdcode;
  let party_rate_cust_code = null;
  if (effAcc && effItem && partyRateMap) {
    party_rate_cust_code = partyRateFromMap(partyRateMap, {
      itemdcode: effItem,
      item_code: enriched?.item_code,
      acc_code: effAcc,
    });
  }

  const result = {
    itemdcode: effItem,
    acc_code: effAcc,
    acc_name: enriched?.acc_name ?? null,
    item_code: enriched?.item_code ?? null,
    item_desc: enriched?.item_desc ?? null,
    job_card_no,
    total_qty,
    doc_dt,
    doc_no: pn,
    party_rate_cust_code:
      party_rate_cust_code != null && String(party_rate_cust_code).trim() !== ""
        ? String(party_rate_cust_code).trim()
        : null,
    standard_qty_per_box,
  };

  SA_PACKING_META_CACHE.set(cacheKey, { at: Date.now(), data: result });
  return result;
}

// Rows for `insertBulkBoxes` / `insertBulkBoxesTx` after an add adjustment is inserted.
export function buildStockAdjustmentAddBoxInsertRows({
  packingNumber,
  adjustmentId,
  totalBoxes,
  perBoxQty,
  isLoose,
  userId,
  boxNoUidPrefix = "",
  override_cust = null,
}) {
  const pn = String(packingNumber ?? "").trim();
  const nb = parseInt(String(totalBoxes), 10);
  const qty = parseInt(String(perBoxQty), 10);
  const cust =
    override_cust != null && String(override_cust).trim() !== ""
      ? String(override_cust).trim()
      : null;
  const rows = [];
  for (let i = 1; i <= nb; i++) {
    rows.push({
      box_no_uid: formatStockAdjustmentBoxNoUid(pn, adjustmentId, nb, i, boxNoUidPrefix),
      packing_number: pn,
      qty,
      is_loose: !!isLoose,
      override_cust: cust,
      created_by: userId,
      sa_id: adjustmentId,
      sa_entry_type: "stock_in"
    });
  }
  return rows;
}

// Extra boxes on pending add edit (indices continue after existing).
export function buildStockAdjustmentAddExtraBoxRows({
  packingNumber,
  adjustmentId,
  totalBoxesAfter,
  startBoxIndex,
  extraCount,
  perBoxQty,
  isLoose,
  userId,
  boxNoUidPrefix = "",
  override_cust = null,
}) {
  const pn = String(packingNumber ?? "").trim();
  const extra = parseInt(String(extraCount), 10);
  const start = parseInt(String(startBoxIndex), 10);
  const total = parseInt(String(totalBoxesAfter), 10);
  const qty = parseInt(String(perBoxQty), 10);
  const cust =
    override_cust != null && String(override_cust).trim() !== ""
      ? String(override_cust).trim()
      : null;
  const rows = [];
  for (let i = 1; i <= extra; i++) {
    const boxIndex = start + i;
    rows.push({
      box_no_uid: formatStockAdjustmentBoxNoUid(pn, adjustmentId, total, boxIndex, boxNoUidPrefix),
      packing_number: pn,
      qty,
      is_loose: !!isLoose,
      override_cust: cust,
      created_by: userId,
      sa_id: adjustmentId,
      sa_entry_type: "stock_in"
    });
  }
  return rows;
}
