import { findBoxes, findBox, findBoxByUidOrNoUid, findBoxByStickerScan, findBoxesByUids, insertBox, insertBulkBoxes, updateBoxes, updateBoxesByUids, deleteBoxes, getStickerHistory, getStickerHistoryFromLiveRow, checkProductionStickersExist, checkSaStockInBoxesExist, incrementDownloadCount, incrementDownloadCountBulk, insertDownloadLog, pickStickerLogFields, getDownloadLogByBox, getDownloadSummaryByPacking, getStickerManagementList, updateDailyProdStickerStatus, findBoxesDetailed, findBoxDetailed, findBoxDetailedByUidOrNoUid, findBoxDetailedByStickerScan, permanentlyDeleteProductionBoxesForPackingNumber, resetDailyProdStickerGeneratedForDoc, findDailyProdByDocNo, findDailyProdStickerRow, findInHandBoxesByPackingNumber, findInHandBoxesByPackingForStockAdjustment, findStockAdjustmentMinusBoxesByPacking, findStockAdjustmentAddBoxesByPattern, findBoxesByPackingNumber } from "../models/box.model.js";
import { enrichOverrideCustomerListRows, listOverrideRequests as listOverrideRequestsQuery } from "../utils/box/overrideCustomerList.js";
import { approveOverrideCustomerRequest, createOverrideCustomerRequest, updateOverrideCustomerRequest } from "../utils/box/overrideCustomerRequests.js";
import { findPackingStandard } from "../models/packingStandard.model.js";
import { fetchFromIMS, fetchPackRowsForFinancialYearDoc } from "../services/ims.service.js";
import { imsPackRowToProduction, findImsPackByDocNo, buildImsDocFilterMany } from "../utils/erp-api/imsPackRow.js";
import { findCustomerHintsForPackings } from "../models/inventoryReport.model.js";
import { buildImsPackDocdtFilter } from "./master.controller.js";
import { getDefaultListViewSpanDays, getBoxNoUidPrefix } from "../../core/models/appConfig.model.js";
import { formatStandardBoxNoUid, docNoFromStandardBoxNoUid } from "../utils/box/boxUid.js";
import { getImsMapsSafe, getImsPartyRateMapSafe, pickPartyRateCustCode, partyRateAccCandidates, enrichRowsWithIMS, resolvePartyRateCustCodeFromIms } from "../utils/erp-api/imsLookup.js";
import { findSuggestedInwardLocationByHierarchy } from "../models/locationMaster.model.js";
import { isBoxInHand, isBoxSellable, isBoxEligibleForOverrideCustomer, overrideCustomerScanRejectMessage, isBoxOnQcHold, isBoxOutwardDispatch, isBoxStockAdjustmentOut, isStockAdjustmentOut } from "../utils/box/boxInventory.js";
import { effectiveBoxCustomerAcc, isBoxCustomerOverridden } from "../utils/box/boxCustomerOverride.js";
import { resolvePackingStickerMetaForPrint } from "../utils/box/stickerPrintMeta.js";
import { invalidateDailyProdGeneratedCache } from "../utils/packing-entry/index.js";
import { buildDailyProdStickerFields, stickerFetchRowFromDailyProd } from "../utils/packing-entry/stickerGenerateSnapshot.js";

import { logActivity } from "../../core/utils/logActivity.js";
import { logOverrideCustomerBatch } from "../utils/box/logBoxTransaction.js";
import { buildPrintDocument, buildStickerPreviewDocument, buildStickerCardHtml, buildStickerPrintDocumentTitle, resolveStickerPackingNumber, sanitizeSearch } from "../../core/utils/helper.js";
import { resolveViewsFields } from "../config/helperViews.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { fillMissingBoxItemFields } from "../utils/box/boxListItemMeta.js";

const BOX_STORE_FILTER_FIELDS = [ "box_uid", "box_no_uid", "packing_number", "sa_id", "location_id", "in_uid", "out_uid", "from_date", "to_date", "journey" ];

const BOX_STORE_LIST_FIELDS = [
  "b.box_uid", "b.box_no_uid", "b.packing_number", "b.qty", "b.override_cust", "b.location_id",
  "b.in_uid", "b.out_uid", "b.sa_id", "b.sa_entry_type", "b.is_loose", "b.qc_hold_id",
  "b.override_cust::text AS acc_name",
  "lm.rack_no", "lm.shelf_no",
  "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no",
  "dp.item_dcode AS prod_item_dcode",
  "dp.item_code AS prod_item_code",
  "dp.item_desc AS prod_item_desc",
  "dp.acc_code AS prod_acc_code",
  "sa.item_dcode AS sa_item_dcode",
  "sa.item_code AS sa_item_code",
  "sa.item_desc AS sa_item_desc",
  "fnm.acc_code AS forward_acc_code",
];

const BOX_AUDIT_RESPONSE_KEYS = new Set([
  "created_by", "created_at",
  "updated_by", "updated_at",
  "deleted_by", "deleted_at",
  "created_by_name", "updated_by_name", "deleted_by_name",
]);

function stripBoxAuditFromClientPayload(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const out = { ...row };
  for (const k of BOX_AUDIT_RESPONSE_KEYS) delete out[k];
  return out;
}

function stripBoxRowsForClient(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(stripBoxAuditFromClientPayload);
}

const NO_SUITABLE_LOCATION_MSG = "No suitable location found";

async function resolveAccAndItemForLocationSuggestion(row) {
  let effAcc =
    effectiveBoxCustomerAcc(row.override_cust, row.prod_acc_code ?? row.acc_code) ??
    row.party_rate_cust_code ??
    row.prod_acc_code ??
    row.acc_code;
  let effItem = row.itemdcode ?? row.item_dcode;

  let missingItem = effItem == null || String(effItem).trim() === "";
  let missingAcc = effAcc == null || String(effAcc).trim() === "";

  const dpLookups = [];
  if ((missingItem || missingAcc) && row.packing_number) {
    dpLookups.push(findDailyProdByDocNo(row.packing_number));
  }
  missingItem = effItem == null || String(effItem).trim() === "";
  missingAcc = effAcc == null || String(effAcc).trim() === "";
  let docFromUid = null;
  if ((missingItem || missingAcc) && row.box_no_uid) {
    docFromUid = docNoFromStandardBoxNoUid(row.box_no_uid);
    if (docFromUid && docFromUid !== row.packing_number) {
      dpLookups.push(findDailyProdByDocNo(docFromUid));
    }
  }
  if (dpLookups.length) {
    const dpRows = await Promise.all(dpLookups);
    for (const dp of dpRows) {
      if (!dp) continue;
      if (missingItem && dp.itemdcode != null && String(dp.itemdcode).trim() !== "") {
        effItem = dp.itemdcode;
        missingItem = false;
      }
      if (missingAcc && dp.acc_code != null && String(dp.acc_code).trim() !== "") {
        effAcc = dp.acc_code;
        missingAcc = false;
      }
    }
  }
  return { acc_code: effAcc, item_dcode: effItem };
}

async function attachSuggestedInwardLocationToBoxRow(row) {
  if (!row || typeof row !== "object") return row;
  const { acc_code: effAcc, item_dcode: effItem } = await resolveAccAndItemForLocationSuggestion(row);
  const { rows: locRows, match_tier } = await findSuggestedInwardLocationByHierarchy({
    acc_code: effAcc,
    item_dcode: effItem
  });
  if (locRows?.length) {
    const enrichedLocs = await enrichRowsWithIMS(locRows, {
      itemCodeField: "item_dcode",
      accCodeField: "acc_code",
      itemCodeOut: "item_code",
      itemDescOut: "item_desc",
      accNameOut: "acc_name"
    });
    return {
      ...row,
      suggested_inward_locations: enrichedLocs,
      suggested_inward_location: enrichedLocs[0] ?? null,
      suggested_location_match_tier: match_tier,
      suggested_location_message: null
    };
  }
  return {
    ...row,
    suggested_inward_locations: [],
    suggested_inward_location: null,
    suggested_location_match_tier: null,
    suggested_location_message: NO_SUITABLE_LOCATION_MSG
  };
}

function stripDownloadLogResponse(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  delete out.downloaded_by;
  delete out.downloaded_by_id;
  delete out.downloaded_by_email;
  return out;
}

function stripDownloadHistoryAggEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const out = { ...entry };
  delete out.downloaded_by_id;
  delete out.downloaded_by;
  return out;
}

function stripDownloadSummaryRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = stripBoxAuditFromClientPayload(row);
  if (Array.isArray(out.download_history)) {
    out.download_history = out.download_history.map(stripDownloadHistoryAggEntry);
  }
  return out;
}

const BOX_ACTIVITY_ENTITY = "boxes";

const ALLOWED_STICKER_DOWNLOAD_SOURCES = new Set([
  "sticker_creation",
  "customer_override",
  "stock_adjustment",
  "qc_hold_material",
  "unknown",
]);

/** Client sends `download_source` on print/track; anything else becomes `unknown`. */
function normalizeStickerDownloadSource(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (ALLOWED_STICKER_DOWNLOAD_SOURCES.has(s)) return s;
  return "unknown";
}

const canonicalCode = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isNaN(n)) return String(Math.trunc(n));
  }
  return s;
};

export const getBoxes = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "created_at", order: "DESC" });

    const result = await findBoxes({
      filters: sanitizeFilters(filters, BOX_STORE_FILTER_FIELDS),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: BOX_STORE_LIST_FIELDS,
      permission: req.permission
    });

    const enriched = await enrichBoxRowsFromIMS(result.data || []);
    const { data, ...rest } = result;
    res.json({ success: true, ...rest, data: stripBoxRowsForClient(enriched || data) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** Stock adjustment minus: in-hand boxes; with adjustment_id also includes that SA's removed boxes. */
export const getInHandBoxesByPacking = async (req, res) => {
  try {
    const pn = String(req.body?.packing_number ?? "").trim();
    if (!pn) {
      return res.status(400).json({ success: false, message: "packing_number is required" });
    }
    const adjIdRaw = req.body?.adjustment_id;
    const adjId =
      adjIdRaw != null && String(adjIdRaw).trim() !== "" ? Number(adjIdRaw) : null;
    const rows = await findStockAdjustmentMinusBoxesByPacking(
      pn,
      Number.isFinite(adjId) && adjId > 0 ? adjId : null,
      { sellableOnly: true }
    );
    const enriched = await enrichBoxRowsFromIMS(rows || []);
    res.json({
      success: true,
      data: stripBoxRowsForClient(enriched),
      total: enriched.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** Stock adjustment add view: all SA add boxes for adjustment (includes stock_out after minus). */
export const getStockAdjustmentAddBoxesByPattern = async (req, res) => {
  try {
    const pn = String(req.body?.packing_number ?? "").trim();
    const adjId = Number(req.body?.adjustment_id);
    if (!pn) {
      return res.status(400).json({ success: false, message: "packing_number is required" });
    }
    if (!Number.isFinite(adjId) || adjId <= 0) {
      return res.status(400).json({ success: false, message: "adjustment_id is required" });
    }
    const rows = await findStockAdjustmentAddBoxesByPattern(pn, adjId);
    const enriched = await enrichBoxRowsFromIMS(rows || []);
    res.json({
      success: true,
      data: stripBoxRowsForClient(enriched),
      total: enriched.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getBoxById = async (req, res) => {
  try {
    const { box_uid } = req.body;

    if (!box_uid)
      return res.status(400).json({ success: false, message: "box_uid required" });

    const data = await findBox({ box_uid });
    if (!data)
      return res.status(404).json({ success: false, message: "Not found" });

    const [enriched] = await enrichBoxRowsFromIMS(data ? [data] : []);
    res.json({ success: true, data: stripBoxAuditFromClientPayload(enriched || data) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createBox = async (req, res) => {
  try {
    let { box_no_uid, packing_number, qty, override_cust, location_id, in_uid, out_uid } = req.body;

    box_no_uid = box_no_uid?.toString().trim();
    packing_number = packing_number?.toString().trim();
    location_id = location_id === "" ? null : location_id;
    in_uid = in_uid === "" ? null : in_uid;
    out_uid = out_uid === "" ? null : out_uid;

    if (!box_no_uid) {
      return res.status(400).json({ success: false, message: "box_no_uid required" });
    }

    if (qty !== undefined && Number.isNaN(Number(qty))) {
      return res.status(400).json({ success: false, message: "qty must be a valid number" });
    }

    const data = await insertBox({ box_no_uid, packing_number, qty, override_cust: override_cust || null, location_id, in_uid, out_uid, created_by: req.user.id });

    const saved = await findBox({ box_uid: data.box_uid });
    await logActivity(req, { action: "create", entity: BOX_ACTIVITY_ENTITY, entity_id: data.box_uid, record: saved || data });
    res.status(201).json({ success: true, data: stripBoxAuditFromClientPayload(saved || data) });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateBox = async (req, res) => {
  try {
    let { box_uid, box_no_uid, packing_number, qty, override_cust, location_id, in_uid, out_uid } = req.body;

    if (!box_uid) {
      return res.status(400).json({ success: false, message: "box_uid required" });
    }

    const existing = await findBox({ box_uid });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Box not found" });
    }

    // Permission-based date restriction (can_edit_days)
    if (req.user.type !== "super_admin" && req.permission && req.permission.can_edit_days > 0) {
      const createdAt = new Date(existing.created_at);
      const now = new Date();
      const diffTime = Math.abs(now - createdAt);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays > req.permission.can_edit_days) {
        return res.status(403).json({ 
          success: false, 
          message: `Edit time limit exceeded. You can only edit records from the last ${req.permission.can_edit_days} days.` 
        });
      }
    }

    box_no_uid = box_no_uid?.toString().trim();
    packing_number = packing_number?.toString().trim();

    const hasChanges = box_no_uid !== undefined || packing_number !== undefined || qty !== undefined || override_cust !== undefined || 
      location_id !== undefined || in_uid !== undefined || out_uid !== undefined;

    if (!hasChanges) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    const fields = {
      ...(box_no_uid !== undefined && { box_no_uid }),
      ...(packing_number !== undefined && { packing_number }),
      ...(qty !== undefined && { qty }),
      ...(override_cust !== undefined && { override_cust: override_cust === "" ? null : override_cust }),
      ...(location_id !== undefined && { location_id: location_id === "" ? null : location_id }),
      ...(in_uid !== undefined && { in_uid: in_uid === "" ? null : in_uid }),
      ...(out_uid !== undefined && { out_uid: out_uid === "" ? null : out_uid }),
      updated_by: req.user.id,
      updated_at: new Date()
    };

    await updateBoxes(fields, { box_uid });

    const data = await findBox({ box_uid });

    await logActivity(req, { action: "update", entity: BOX_ACTIVITY_ENTITY, entity_id: box_uid, details: { updated_fields: fields } });

    res.json({ success: true, data: stripBoxAuditFromClientPayload(data) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteBox = async (req, res) => {
  try {
    const { box_uid } = req.body;
    if (!box_uid)
      return res.status(400).json({ success: false, message: "box_uid required" });

    const existing = await findBox({ box_uid });

    if (!existing) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    await deleteBoxes(
      { box_uid }, 
      { deleted_by: req.user.id }
    );

    await logActivity(req, { action: "delete", entity: BOX_ACTIVITY_ENTITY, entity_id: box_uid, record: existing });

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getBoxesViews = async (req, res) => {
  console.time("API_Execution");
  try {
    const { id, box_no_uid, box_uid, permission_module, permission_action } = req.body;
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "box_uid", order: "DESC" });
    const include_suggested_inward_location = req.body.include_suggested_inward_location === true;

    const scanNoUid =
      box_no_uid != null && String(box_no_uid).trim() !== "" ? String(box_no_uid).trim() : null;
    const scanUid =
      box_uid != null && String(box_uid).trim() !== "" && /^\d+$/.test(String(box_uid).trim())
        ? String(box_uid).trim()
        : null;
    const legacyId = id != null && String(id).trim() !== "" ? String(id).trim() : null;

    if (legacyId || scanNoUid || scanUid) {
      if (include_suggested_inward_location && permission_module === "inventory_inwards" && permission_action === "view") {
        const boxDetailed =
          scanNoUid || scanUid
            ? await findBoxDetailedByStickerScan({ box_no_uid: scanNoUid, box_uid: scanUid })
            : await findBoxDetailedByUidOrNoUid(legacyId);
        if (!boxDetailed || boxDetailed.is_deleted || !isBoxInHand(boxDetailed)) {
          return res.json({ success: true, data: null });
        }
        const displayRow = await enrichSingleBoxForFinder(boxDetailed);
        const withSuggestion = await attachSuggestedInwardLocationToBoxRow(stripBoxAuditFromClientPayload(displayRow));
        return res.json({ success: true, data: stripBoxAuditFromClientPayload(withSuggestion) });
      }

      const useDetailedLookup = permission_module === "change_override_customer" || (permission_module === "boxes" && permission_action === "view");

      let boxRow = null;
      if (scanNoUid || scanUid) {
        boxRow = useDetailedLookup
          ? await findBoxDetailedByStickerScan({ box_no_uid: scanNoUid, box_uid: scanUid })
          : await findBoxByStickerScan({ box_no_uid: scanNoUid, box_uid: scanUid });
      }
      if (!boxRow && legacyId) {
        boxRow = useDetailedLookup
          ? await findBoxDetailedByUidOrNoUid(legacyId)
          : await findBoxByUidOrNoUid(legacyId);
      }
      if (!boxRow || boxRow.is_deleted) {
        return res.json({ success: true, data: null });
      }
      if (permission_module === "change_override_customer" && !isBoxEligibleForOverrideCustomer(boxRow)) {
        return res.json({
          success: true,
          data: null,
          reject_reason: overrideCustomerScanRejectMessage(boxRow),
        });
      }
      const displayRow =
        permission_module === "boxes" && permission_action === "view"
          ? await enrichSingleBoxForFinder(boxRow)
          : (await enrichBoxRowsFromIMS([boxRow]))[0] || boxRow;
      return res.json({
        success: true,
        data: stripBoxAuditFromClientPayload(displayRow),
      });
    }

    let fields = resolveViewsFields("boxes", { permission_module, permission_action });

    if (include_suggested_inward_location && permission_module === "inventory_inwards" && permission_action === "view") {
      const extra = ["b.override_cust", "dp.acc_code AS prod_acc_code", "dp.item_dcode AS itemdcode"];
      fields = [...fields, ...extra];
    }

    const safeFilters = sanitizeFilters(filters, BOX_STORE_FILTER_FIELDS);

    const result = await findBoxes({
      filters: safeFilters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page: page || 1,
      limit: limit || 5000,
      fields: fields || ["b.box_uid AS id", "b.box_no_uid", "b.packing_number", "b.qty", "b.override_cust::text AS acc_name", "b.location_id", "b.in_uid", "b.out_uid"],
      permission: req.permission
    });

    let enriched = await enrichBoxRowsFromIMS(result.data || []);
    if (permission_module === "inventory_inwards" || permission_module === "stock_adjustment") {
      enriched = (enriched || []).filter((row) => isBoxSellable(row));
    }
    if (permission_module === "change_override_customer") {
      enriched = (enriched || []).filter((row) => isBoxEligibleForOverrideCustomer(row));
    }
    if (include_suggested_inward_location && permission_module === "inventory_inwards" && permission_action === "view" && Array.isArray(enriched) && enriched.length) {
      enriched = await Promise.all(enriched.map((row) => attachSuggestedInwardLocationToBoxRow(row)));
    }

    const { data, ...rest } = result;
    return res.json({ success: true, ...rest, data: stripBoxRowsForClient(enriched || data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    console.timeEnd("API_Execution");
  }
};

function normalizeStickerProductionPayload(p, fallbackDocNo) {
  if (!p || typeof p !== "object") return null;
  const dn = p.doc_no != null && String(p.doc_no).trim() !== "" ? String(p.doc_no).trim() : String(fallbackDocNo ?? "").trim();
  const itemdcode = p.itemdcode ?? p.item_dcode;
  const item_code = p.item_code ?? null;
  if (!dn || itemdcode == null || String(itemdcode).trim() === "") return null;
  return {
    doc_no: dn,
    doc_dt: p.doc_dt ?? null,
    job_card_no: p.job_card_no ?? null,
    itemdcode,
    item_code,
    total_qty: p.total_qty != null ? p.total_qty : "0",
    acc_code: p.acc_code ?? null,
    sticker_generated: !!p.sticker_generated,
    packing_standard_id: p.packing_standard_id ?? null
  };
}

/** Client sticker_meta packing fields only — customer is resolved per box at bulk print. */
function packingLevelStickerHints(sticker_meta = {}) {
  if (!sticker_meta || typeof sticker_meta !== "object") return {};
  const {
    acc_code: _acc,
    acc_name: _name,
    party_rate_cust_code: _pr,
    box_no: _boxNo,
    total_boxes: _totalBoxes,
    ...rest
  } = sticker_meta;
  return rest;
}

/** Merge IMS-enriched box row with optional sticker_meta from packing-entry UI. */
function mergeStickerPrintRow(enrichedBox, sticker_meta = {}, packingHint = null) {
  const meta = sticker_meta && typeof sticker_meta === "object" ? sticker_meta : {};
  const metaItemCode = meta.item_code ?? meta.itemdcode ?? null;
  const metaDesc = meta.itemdesc ?? meta.description ?? meta.item_desc ?? null;
  const metaJob = meta.job_no ?? meta.job_card_no ?? null;
  const metaAccName = meta.acc_name ?? null;
  const packing_number = resolveStickerPackingNumber(
    { ...enrichedBox, ...meta },
    packingHint ?? enrichedBox?.packing_number ?? meta.packing_number ?? meta.doc_no
  );

  return {
    ...enrichedBox,
    ...meta,
    packing_number,
    item_code: enrichedBox?.item_code || metaItemCode || null,
    itemdesc: enrichedBox?.itemdesc || metaDesc || null,
    item_desc: enrichedBox?.item_desc || metaDesc || null,
    job_no: metaJob || enrichedBox?.job_no || null,
    doc_dt: meta.doc_dt ?? meta.docdt ?? enrichedBox?.doc_dt ?? null,
    acc_name: metaAccName || enrichedBox?.acc_name || null,
    acc_code: meta.acc_code ?? enrichedBox?.acc_code ?? null,
    party_rate_cust_code: meta.party_rate_cust_code ?? enrichedBox?.party_rate_cust_code ?? null,
  };
}

/** Box finder scan: resolve customer + item like sticker print (single-box only). */
async function enrichSingleBoxForFinder(boxRow) {
  if (!boxRow || typeof boxRow !== "object") return boxRow;

  const [imsRow] = await enrichBoxRowsFromIMS([boxRow]);
  const base = imsRow || boxRow;
  const pn = String(base.packing_number ?? "").trim();

  const { acc_code: resolvedAcc, item_dcode: resolvedItem } =
    await resolveAccAndItemForLocationSuggestion(base);

  const packingMeta = pn
    ? await resolvePackingStickerMetaForPrint(pn, {
        itemdcode: resolvedItem ?? base.itemdcode ?? base.item_dcode,
        acc_code: resolvedAcc ?? base.prod_acc_code ?? base.acc_code,
        override_cust: base.override_cust,
        sa_id: base.sa_id,
        job_card_no: base.job_no,
        doc_dt: base.doc_dt,
      })
    : {};

  const packingAcc =
    packingMeta.acc_code != null && String(packingMeta.acc_code).trim() !== ""
      ? String(packingMeta.acc_code).trim()
      : canonicalCode(base.prod_acc_code ?? base.acc_code);
  const overridden = isBoxCustomerOverridden(base.override_cust, packingAcc);
  const acc_code = overridden
    ? effectiveBoxCustomerAcc(base.override_cust, packingAcc) ?? base.acc_code
    : packingAcc ?? base.acc_code;

  const itemdcode =
    resolvedItem ?? base.itemdcode ?? base.item_dcode ?? packingMeta.itemdcode ?? null;

  const { itemMap, ledgerMap } = await getImsMapsSafe();
  const item = itemdcode != null ? itemMap.get(canonicalCode(itemdcode)) : null;
  const accNameFromLedger = acc_code != null ? ledgerMap.get(canonicalCode(acc_code)) : null;
  const acc_name =
    accNameFromLedger ??
    packingMeta.acc_name ??
    base.acc_name ??
    null;

  const party_rate_cust_code = acc_code
    ? await resolvePartyRateCustCodeFromIms({
        itemdcode,
        item_code: item?.item_code ?? packingMeta.item_code ?? base.item_code,
        acc_code,
      })
    : null;

  return {
    ...base,
    itemdcode,
    item_dcode: itemdcode,
    item_code: item?.item_code ?? packingMeta.item_code ?? base.item_code ?? null,
    item_desc: item?.item_desc ?? packingMeta.itemdesc ?? base.item_desc ?? base.itemdesc ?? null,
    itemdesc: item?.item_desc ?? packingMeta.itemdesc ?? base.itemdesc ?? base.item_desc ?? null,
    acc_code: acc_code ?? base.acc_code,
    acc_name,
    party_rate_cust_code:
      party_rate_cust_code != null && String(party_rate_cust_code).trim() !== ""
        ? String(party_rate_cust_code).trim()
        : packingMeta.party_rate_cust_code ?? null,
    job_no: packingMeta.job_card_no ?? packingMeta.job_no ?? base.job_no ?? null,
    doc_dt: packingMeta.doc_dt ?? base.doc_dt ?? null,
    stock_zone: resolveBoxListStockZone(base),
  };
}

function resolveBoxListStockZone(row) {
  if (isBoxOnQcHold(row)) return "qc_hold";
  if (isBoxOutwardDispatch(row)) return "dispatched";
  if (isBoxInHand(row)) return row.location_id ? "in_store" : "packing_area";
  if (isStockAdjustmentOut(row) || isBoxStockAdjustmentOut(row)) return "removed";
  return "other";
}

async function enrichBoxRowsFromIMS(rows = [], maps = null) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const { itemMap, ledgerMap } = maps ?? (await getImsMapsSafe());
  const mapped = rows.map((row) => {
    const itemCodeRaw =
      row.sa_item_dcode ?? row.prod_item_dcode ?? row.itemdcode ?? row.item_dcode;
    const itemCode = canonicalCode(itemCodeRaw);
    const item = itemCode ? itemMap.get(itemCode) : null;
    const packingAcc = canonicalCode(row.prod_acc_code ?? row.acc_code);
    const accCode =
      canonicalCode(effectiveBoxCustomerAcc(row.override_cust, packingAcc)) ??
      canonicalCode(row.override_cust ?? row.acc_code ?? row.acc_name);
    const accNameFromLedger = accCode ? ledgerMap.get(accCode) : null;
    const custSnapshot =
      row.cust_at_time != null && String(row.cust_at_time).trim() !== ""
        ? String(row.cust_at_time).trim()
        : null;
    const rawAccName =
      row.acc_name != null && String(row.acc_name).trim() !== ""
        ? String(row.acc_name).trim()
        : null;
    const nameLooksLikeCode =
      accCode &&
      rawAccName &&
      (rawAccName === String(accCode) || rawAccName === canonicalCode(accCode));
    const acc_name =
      accNameFromLedger ??
      (custSnapshot && custSnapshot !== String(accCode) ? custSnapshot : null) ??
      (rawAccName && !nameLooksLikeCode ? rawAccName : null);

    const forwardCode = canonicalCode(row.forward_acc_code);
    const dispatched = isBoxOutwardDispatch(row);
    const forward_note_customer_name =
      dispatched && forwardCode ? ledgerMap.get(forwardCode) ?? forwardCode : "—";

    const resolvedItemCode =
      row.prod_item_code ?? row.sa_item_code ?? item?.item_code ?? row.item_code ?? null;
    const resolvedItemDesc =
      row.prod_item_desc ??
      row.sa_item_desc ??
      item?.item_desc ??
      row.itemdesc ??
      row.item_desc ??
      null;

    return {
      ...row,
      item_dcode: itemCode ?? row.item_dcode ?? null,
      itemdcode: itemCode ?? row.itemdcode ?? null,
      item_code: resolvedItemCode,
      itemdesc: resolvedItemDesc,
      item_desc: resolvedItemDesc,
      acc_code: accCode ?? row.acc_code ?? null,
      acc_name,
      forward_note_customer_name,
      stock_zone: resolveBoxListStockZone(row),
      box_kind: row.is_loose === true || row.is_loose === 1 ? "Loose" : "Full",
      party_rate_cust_code: null,
      from_customer_name: (row.from_customer != null ? ledgerMap.get(String(row.from_customer)) : null) ?? row.from_customer_name ?? null,
      to_customer_name: (row.to_customer != null ? ledgerMap.get(String(row.to_customer)) : null) ?? row.to_customer_name ?? null,
      item_name: resolvedItemCode ?? row.item_name ?? null
    };
  });

  return fillMissingBoxItemFields(mapped, itemMap);
}

function accNameFromLedger(ledgerMap, accCodeRaw) {
  const code = canonicalCode(accCodeRaw);
  if (!code) return null;
  return ledgerMap.get(code) ?? null;
}

/** Cache only for sticker download logs list (does not affect other screens). */
const STICKER_MGMT_MAPS_TTL_MS = Math.max(60_000, Number(process.env.IMS_MAPS_CACHE_MS) || 300_000);
let stickerMgmtMapsCache = null;
let stickerMgmtMapsCacheAt = 0;

async function getImsMapsForStickerMgmtList() {
  const now = Date.now();
  if (stickerMgmtMapsCache && now - stickerMgmtMapsCacheAt < STICKER_MGMT_MAPS_TTL_MS) {
    return stickerMgmtMapsCache;
  }
  const maps = await getImsMapsSafe();
  stickerMgmtMapsCache = maps;
  stickerMgmtMapsCacheAt = now;
  return maps;
}

/** Fast list enrichment: one DB batch + minimal lookups (no per-row network calls for list). */
async function enrichStickerManagementListRows(rows = []) {
  if (!rows.length) return rows;
  const maps = await getImsMapsForStickerMgmtList();
  
  // 1. Basic enrichment from maps (item/ledger)
  const enriched = await enrichBoxRowsFromIMS(rows, maps);

  // 2. Identify rows still missing customer names
  const needResolve = enriched.filter(
    (r) => !r.acc_name || String(r.acc_name).trim() === "" || /^\d+$/.test(String(r.acc_name))
  );
  if (!needResolve.length) return enriched;

  // 3. Try to resolve from local dailyprod hints (no network calls)
  const packingNums = [
    ...new Set(needResolve.map((r) => String(r.packing_number).trim()).filter(Boolean)),
  ];
  
  const hints = await findCustomerHintsForPackings(packingNums);
  const codeByPacking = new Map();
  for (const h of hints || []) {
    const pn = String(h.packing_number ?? "").trim();
    const code = h.customer_code != null ? String(h.customer_code).trim() : "";
    if (pn && code) codeByPacking.set(pn, code);
  }

  return enriched.map((row) => {
    if (row.acc_name && !/^\d+$/.test(String(row.acc_name))) return row;
    
    const pn = String(row.packing_number ?? "").trim();
    const code = codeByPacking.get(pn) || row.acc_code;
    if (!code) return row;
    
    const name = accNameFromLedger(maps.ledgerMap, code);
    return {
      ...row,
      acc_code: row.acc_code ?? code,
      acc_name: name ?? row.acc_name ?? code,
    };
  });
}

/** Which customer acc_code applies on sticker screen (box override after customer override, else packing row). */
async function resolveStickerCustomerAccCode(docNo, fallbackAcc = null) {
  const fb =
    fallbackAcc != null && String(fallbackAcc).trim() !== "" ? String(fallbackAcc).trim() : null;
  // Packing-level customer stays on production / ERP acc — per-box overrides are sticker-only.
  return fb;
}

/**
 * Sticker cust. code = IMS party-rate narr1 for (customer acc_code + item dcode) only.
 * No narr for that pair → null (never reuse another customer's code).
 */
async function applyStickerCustCodeNarr(rows, accCode) {
  if (!Array.isArray(rows) || !rows.length) return rows;

  const acc =
    accCode != null && String(accCode).trim() !== "" ? String(accCode).trim() : null;
  const itemdcode = rows[0]?.itemdcode;
  if (!acc || itemdcode == null || String(itemdcode).trim() === "") {
    return rows.map((r) => ({ ...r, party_rate_cust_code: null }));
  }

  const narr = await resolvePartyRateCustCodeFromIms({
    acc_code: acc,
    itemdcode,
    item_code: rows[0]?.item_code,
  });
  const narrVal =
    narr != null && String(narr).trim() !== "" ? String(narr).trim() : null;

  return rows.map((r) => ({
    ...r,
    acc_code: acc,
    party_rate_cust_code: narrVal,
  }));
}

async function enrichStickerRowsFromIMS(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const [{ itemMap, ledgerMap }, partyRateMap] = await Promise.all([
    getImsMapsSafe(),
    getImsPartyRateMapSafe()
  ]);

  return rows.map((row) => {
    const itemCode = canonicalCode(row.itemdcode ?? row.item_dcode ?? row.prod_item_dcode);
    const item = itemCode ? itemMap.get(itemCode) : null;
    const accCode = canonicalCode(row.acc_code);
    const accName = accCode ? ledgerMap.get(accCode) : null;
    const rateAcc = partyRateAccCandidates(row.acc_code);
    const partyRateCustCode =
      pickPartyRateCustCode(partyRateMap, itemCode, rateAcc) ||
      pickPartyRateCustCode(partyRateMap, item?.item_code ?? row.item_code, rateAcc);
    const resolvedItemCode =
      row.prod_item_code ?? row.item_code ?? item?.item_code ?? null;
    const resolvedItemDesc =
      row.prod_item_desc ?? item?.item_desc ?? row.itemdesc ?? row.item_desc ?? null;
    return {
      ...row,
      item_code: resolvedItemCode,
      itemdesc: resolvedItemDesc,
      item_desc: resolvedItemDesc,
      acc_name: accName ?? row.acc_name ?? null,
      party_rate_cust_code: partyRateCustCode ?? row.party_rate_cust_code ?? null
    };
  });
}

/** Uses local `ims_dailyprod` when present; otherwise live row from client `production` or IMS pack + ims_packing_standard join (no ims_dailyprod seed). */
export const stickerFetchBox = async (req, res) => {
  try {
    const { doc_no, category_id, production, ims_date_filter } = req.body;

    if (!doc_no) {
      return res.status(400).json({ success: false, message: "doc_no (Packing No) is required" });
    }

    const docNo = String(doc_no).trim();
    const productionStickersExistEarly = await checkProductionStickersExist(docNo);

    // Fast path: stickers already generated — return frozen snapshot (no IMS / packing-standard join).
    if (productionStickersExistEarly) {
      const dpRow = await findDailyProdStickerRow(docNo);
      const snapRow = stickerFetchRowFromDailyProd(dpRow);
      if (snapRow && dpRow?.sticker_generated) {
        const sa_adjustment_boxes_exist = await checkSaStockInBoxesExist(docNo);
        return res.json({
          success: true,
          data: [snapRow],
          production_stickers_exist: true,
          sa_adjustment_boxes_exist,
          message: "Sticker snapshot loaded",
        });
      }
    }

    let rows = await getStickerHistory(doc_no, category_id);

    const liveFromBody = normalizeStickerProductionPayload(production, doc_no);

    const accOverride =
      liveFromBody?.acc_code != null && String(liveFromBody.acc_code).trim() !== ""
        ? String(liveFromBody.acc_code).trim()
        : null;
    let clientAccDiffersFromHistory = false;

    if (accOverride && rows?.length > 0) {
      const dpAcc =
        rows[0]?.acc_code != null && String(rows[0].acc_code).trim() !== ""
          ? String(rows[0].acc_code).trim()
          : "";
      if (dpAcc !== accOverride) {
        clientAccDiffersFromHistory = true;
        const liveRow = {
          doc_no: String(doc_no).trim(),
          doc_dt: liveFromBody?.doc_dt ?? rows[0]?.doc_dt ?? null,
          job_card_no: liveFromBody?.job_card_no ?? rows[0]?.job_card_no ?? null,
          itemdcode: liveFromBody?.itemdcode ?? rows[0]?.itemdcode ?? null,
          total_qty: liveFromBody?.total_qty ?? rows[0]?.total_qty ?? "0",
          acc_code: accOverride,
          sticker_generated: liveFromBody?.sticker_generated ?? rows[0]?.sticker_generated ?? false,
          packing_standard_id:
            liveFromBody?.packing_standard_id ?? rows[0]?.packing_standard_id ?? null,
        };
        const liveRows = await getStickerHistoryFromLiveRow(liveRow, category_id);
        if (liveRows?.length) {
          rows = liveRows;
        } else {
          rows = rows.map((r) => ({ ...r, acc_code: accOverride }));
        }
      }
    }

    if ((!rows || rows.length === 0) && liveFromBody) {
      rows = await getStickerHistoryFromLiveRow(liveFromBody, category_id);
    }

    if (!rows || rows.length === 0) {
      const fd = ims_date_filter?.from_date ?? ims_date_filter?.fromDate;
      const td = ims_date_filter?.to_date ?? ims_date_filter?.toDate;
      const defaultSpanDays = await getDefaultListViewSpanDays();
      const imsPackFilter =
        fd || td ? buildImsPackDocdtFilter({ from_date: fd, to_date: td }, defaultSpanDays) : "";

      let imsRecords = [];
      try {
        imsRecords = await fetchFromIMS("pack", imsPackFilter || null);
      } catch {
        imsRecords = [];
      }

      let imsLive = imsPackRowToProduction(findImsPackByDocNo(imsRecords, doc_no));

      if ((!imsLive || imsLive.itemdcode == null) && !imsPackFilter) {
        const allPack = await fetchFromIMS("pack");
        imsLive = imsPackRowToProduction(findImsPackByDocNo(allPack, doc_no));
      }

      if (imsLive?.itemdcode != null && String(imsLive.itemdcode).trim() !== "") {
        rows = await getStickerHistoryFromLiveRow(imsLive, category_id);
      }
    }

    if (!rows || rows.length === 0) {
      const msg = category_id ? "No packing standard found for this ims_category" : "No history found for this Packing No";
      return res.status(200).json({ success: false, message: msg });
    }

    rows = await enrichStickerRowsFromIMS(rows);
    rows = rows.map((r) => ({ ...r, party_rate_cust_code: null }));

    const explicitClientAcc =
      liveFromBody?.acc_code != null && String(liveFromBody.acc_code).trim() !== ""
        ? String(liveFromBody.acc_code).trim()
        : null;
      const fallbackAcc =
      explicitClientAcc ??
      (rows[0]?.acc_code != null ? String(rows[0].acc_code).trim() : null);

    const productionStickersExist = await checkProductionStickersExist(String(doc_no).trim());
    let stickerAcc = fallbackAcc;
    if (productionStickersExist) {
      stickerAcc = (await resolveStickerCustomerAccCode(doc_no, fallbackAcc)) ?? fallbackAcc;
    } else if (clientAccDiffersFromHistory && explicitClientAcc) {
      stickerAcc = explicitClientAcc;
    }
    rows = await applyStickerCustCodeNarr(rows, stickerAcc);
    if (stickerAcc) {
      rows = rows.map((r) => ({ ...r, acc_code: stickerAcc }));
    }

    // Logic for multiple categories
    if (!category_id) {
      const uniqueCategories = [...new Set(rows.map(r => r.type).filter(t => t !== null))];
      
      // Production stickers only (SA add boxes do not count as generated here).
      const isGenerated = await checkProductionStickersExist(String(doc_no).trim());

      if (uniqueCategories.length > 1 && !isGenerated) {
        // Return first row but WITHOUT packing_details to force selection
        const baseRow = rows[0];
        return res.json({ 
          success: true, 
          multiple_categories: true,
          data: [{
            ...baseRow,
            packing_details: null
          }],
          message: "Multiple categories found. Please select one."
        });
      }
    }

    // Use the first matching row (if category_id provided, it will be the specific one)
    const row = rows[0];
    const totalQty = parseFloat(row.total_qty || 0);
    const stdQty   = parseFloat(row.standard_qty_per_box || 0);
    
    if (!stdQty) {
      return res.json({ 
        success: true, 
        data: [{ ...row, packing_details: null }],
        message: "No standard qty found for this item."
      });
    }

    const fullBoxes = Math.floor(totalQty / stdQty);
    const looseQty  = totalQty % stdQty;

    const data = [{
      ...row,
      item_code: row.item_code,
      itemdesc: row.itemdesc,
      packing_details: {
        package_num     : row.doc_no,
        standard_id     : row.standard_id,
        total_qty       : totalQty,
        qty_per_box     : stdQty,
        full_boxes_count: fullBoxes,
        loose_box_qty   : looseQty > 0 ? Number(looseQty.toFixed(3)) : 0,
        total_stickers  : fullBoxes + (looseQty > 0 ? 1 : 0)
      }
    }];

    const pn = String(doc_no).trim();
    const production_stickers_exist = await checkProductionStickersExist(pn);
    const sa_adjustment_boxes_exist = await checkSaStockInBoxesExist(pn);

    res.json({
      success: true,
      data,
      production_stickers_exist,
      sa_adjustment_boxes_exist,
      message: "History fetched with calculations",
    });
  } catch (err) {
    console.error("stickerFetchBox Error:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// POST /box/sticker/generate
// Body: { doc_no, itemdcode, acc_name, acc_code, packing_config }
export const generateStickers = async (req, res) => {
  try {
    // 1. Validation: Basic fields check
    const { doc_no, itemdcode, item_code, acc_name, acc_code, packing_config, doc_dt, job_card_no, total_qty, unit, party_rate_cust_code, category_id, category_name, itemdesc, description, fg_location, internal_create_user, internal_create_date } = req.body;
    
    if (!doc_no || !itemdcode || !packing_config) {
      console.log("Validation failed. Missing fields:", { doc_no, itemdcode, packing_config });
      return res.status(400).json({ 
        success: false, 
        message: "Required fields are missing (Doc No, Item Code, Packing Config)." 
      });
    }

    const { full_boxes_count, qty_per_box, loose_box_qty, total_stickers } = packing_config;

    if (!total_stickers || total_stickers <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid packing config: sticker count must be greater than zero." 
      });
    }

    const docNo = String(doc_no).trim();

    // Block only when production stickers already exist (not SA add placeholders).
    const productionExists = await checkProductionStickersExist(docNo);
    if (productionExists) {
      return res.status(409).json({
        success: false,
        message: `Stickers for Doc #${docNo} have already been generated.`,
      });
    }

    // SA add boxes (e.g. *_SA*_* UIDs) may exist on the same packing; production stickers use normal UIDs only.

    const boxNoUidPrefix = await getBoxNoUidPrefix();
    const rowsToInsert = [];
    for (let i = 1; i <= total_stickers; i++) {
      const isLoose = i > full_boxes_count;
      const custom_uid = formatStandardBoxNoUid(doc_no, total_stickers, i, boxNoUidPrefix);

      rowsToInsert.push({
        box_no_uid     : custom_uid, 
        packing_number : String(doc_no),
        qty            : Number(isLoose ? loose_box_qty : qty_per_box),
        is_loose       : isLoose,
        override_cust  : null,
        created_by     : req.user.id
      });
    }

    const inserted = await insertBulkBoxes(rowsToInsert);

    if (!inserted || inserted.length === 0) {
      throw new Error("No rows were inserted.");
    }

    // Daily prod row: freeze packing + customer snapshot at generate time (fast reads later).
    const stdId = packing_config.standard_id || null;
    const stickerFields = buildDailyProdStickerFields({ doc_no, itemdcode, item_code, acc_name, acc_code, doc_dt, job_card_no, total_qty, unit,
      party_rate_cust_code, category_id, category_name, itemdesc: itemdesc ?? description, fg_location, internal_create_user, internal_create_date,
      system_generate_user: req.user.name, system_generate_date: new Date().toISOString(), packing_config,
    });
    try {
      await updateDailyProdStickerStatus(doc_no, stdId, stickerFields);
    } catch (dailyprodErr) {
      await permanentlyDeleteProductionBoxesForPackingNumber({
        packing_number: docNo,
        user_id: req.user?.id,
      }).catch((rollbackErr) => {
        console.error("generateStickers rollback failed:", rollbackErr.message);
      });
      throw dailyprodErr;
    }
    invalidateDailyProdGeneratedCache();

    const data = inserted.map((row, idx) => ({
      ...stripBoxAuditFromClientPayload(row),
      box_no      : idx + 1,
      total_boxes : total_stickers,
      type        : row.is_loose ? "LOOSE" : "FULL",
      acc_code,
      acc_name,
      itemdcode
    }));

    // 5. Activity Logging
    await logActivity(req, {
      action    : "generate_stickers",
      entity    : BOX_ACTIVITY_ENTITY,
      entity_id : String(doc_no),
      meta      : { total_stickers, itemdcode, acc_name }
    });

    res.status(201).json({ 
      success : true, 
      message : `Successfully generated ${data.length} stickers for Doc #${doc_no}.`, 
      data 
    });

  } catch (err) {
    console.error("generateStickers Error:", err);
    res.status(500).json({ success: false, message: "Server Error: Sticker generation process fail. " + err.message });
  }
};

/** One sticker HTML (box 1) before DB insert — same layout as print, no download log. */
export const previewSticker = async (req, res) => {
  try {
    const { doc_no, itemdcode, acc_name, acc_code, packing_config, doc_dt, job_card_no, unit } = req.body;

    if (!doc_no || !itemdcode || !packing_config) {
      return res.status(400).json({
        success: false,
        message: "Required fields are missing (Doc No, Item Code, Packing Config).",
      });
    }

    const { full_boxes_count, qty_per_box, loose_box_qty, total_stickers } = packing_config;

    if (!total_stickers || Number(total_stickers) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid packing config: sticker count must be greater than zero.",
      });
    }

    const totalN = Number(total_stickers);
    const fullCount = Number(full_boxes_count) || 0;
    const isLoose = 1 > fullCount;
    const qty = Number(isLoose ? loose_box_qty : qty_per_box) || 0;
    const boxNoUidPrefix = await getBoxNoUidPrefix();
    const box_no_uid = formatStandardBoxNoUid(doc_no, totalN, 1, boxNoUidPrefix);

    const baseRow = {
      box_no_uid,
      packing_number: String(doc_no),
      qty,
      is_loose: isLoose,
      itemdcode,
      acc_code: acc_code || null,
      acc_name: acc_name || null,
      doc_dt: doc_dt != null && doc_dt !== "" ? doc_dt : null,
      created_at: new Date().toISOString(),
      job_no: job_card_no || null,
      unit: unit || "PCS",
    };

    const [enriched] = await enrichStickerRowsFromIMS([baseRow]);
    const [withCustCode] = await applyStickerCustCodeNarr([enriched], acc_code);
    const card = await buildStickerCardHtml({
      ...withCustCode,
      acc_name: withCustCode?.acc_name || acc_name,
    });

    const html = buildStickerPreviewDocument(card);
    res.json({
      success: true,
      html,
      sample_box_no: 1,
      total_stickers: totalN,
      message: `Preview: box 1 of ${totalN} (same layout as after generate).`,
    });
  } catch (err) {
    console.error("previewSticker Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /boxes/sticker/remove — delete production stickers only (SA add boxes unchanged)
export const removeGeneratedStickers = async (req, res) => {
  try {
    const { doc_no, box_uids } = req.body;
    if (doc_no == null || String(doc_no).trim() === "") {
      return res.status(400).json({ success: false, message: "doc_no is required." });
    }
    if (box_uids !== undefined && box_uids !== null) {
      return res.status(400).json({
        success: false,
        message: "Sticker remove is for all production stickers on this packing only — do not send box_uids.",
      });
    }

    const pn = String(doc_no).trim();

    const deletedRows = await permanentlyDeleteProductionBoxesForPackingNumber({
      packing_number: pn,
      user_id: req.user?.id,
    });

    const deletedCount = Array.isArray(deletedRows) ? deletedRows.length : 0;
    if (deletedCount === 0) {
      const saRemain = await checkSaStockInBoxesExist(pn);
      return res.status(404).json({
        success: false,
        message: saRemain
          ? "No production stickers to remove. Stock adjustment boxes are unchanged."
          : "No production sticker rows found for this packing.",
      });
    }

    const saRemain = await checkSaStockInBoxesExist(pn);
    let dailyprod_reset = false;
    if (!(await checkProductionStickersExist(pn))) {
      await resetDailyProdStickerGeneratedForDoc(pn);
      dailyprod_reset = true;
    }
    invalidateDailyProdGeneratedCache();

    await logActivity(req, {
      action: "delete_generated_stickers",
      entity: BOX_ACTIVITY_ENTITY,
      entity_id: pn,
      meta: {
        deleted_count: deletedCount,
        scope: "production_only",
        sa_boxes_preserved: saRemain,
        permanent: true,
        dailyprod_reset,
      },
    });

    let message = `Removed ${deletedCount} production sticker(s).`;
    if (saRemain) {
      message += " Stock adjustment boxes were not changed.";
    } else if (dailyprod_reset) {
      message += " You can generate again when ERP data is ready.";
    }

    res.json({
      success: true,
      message,
      deleted_count: deletedCount,
      sa_boxes_preserved: saRemain,
      dailyprod_reset,
    });
  } catch (err) {
    console.error("removeGeneratedStickers Error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to remove stickers." });
  }
};

// POST /box/sticker/download
// Body: { box_uid }
export const trackStickerDownload = async (req, res) => {
  try {
    const { box_uid: boxUidRaw } = req.body;
    const download_source = normalizeStickerDownloadSource(req.body.download_source);
    const box_uid = Number(boxUidRaw);
    if (!Number.isFinite(box_uid) || box_uid <= 0)
      return res.status(400).json({ success: false, message: "box_uid required" });

    const box = await findBox({ box_uid });
    if (!box)
      return res.status(404).json({ success: false, message: "Box not found" });

    const [enrichedBox] = await enrichBoxRowsFromIMS([box]);

    // Log entry
    const log = await insertDownloadLog({
      box_uid,
      ...pickStickerLogFields(enrichedBox, box),
      downloaded_by: req.user.id,
      download_type: "single",
      download_source,
    });

    // Count increment
    const updated = await incrementDownloadCount(box_uid, req.user.id);

    res.json({
      success        : true,
      message        : "Download logged",
      download_count : updated.download_count,
      log: stripDownloadLogResponse(log)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /box/sticker/download-bulk
// Body: { box_uids: [1, 2, 3] }
export const trackBulkDownload = async (req, res) => {
  try {
    const { box_uids } = req.body;
    const download_source = normalizeStickerDownloadSource(req.body.download_source);
    if (!box_uids?.length)
      return res.status(400).json({ success: false, message: "box_uids array required" });

    const boxes = await findBoxesDetailed({ box_uids: box_uids.map((id) => String(id)) });
    if (!boxes.length)
      return res.status(404).json({ success: false, message: "No matching boxes" });

    const enrichedBoxes = await enrichBoxRowsFromIMS(boxes);
    const packingNo = String(enrichedBoxes[0]?.packing_number ?? "").trim();
    if (!packingNo)
      return res.status(400).json({ success: false, message: "packing_number missing on boxes" });

    const uids = enrichedBoxes.map((b) => Number(b.box_uid)).filter((n) => Number.isFinite(n) && n > 0);
    if (!uids.length)
      return res.status(400).json({ success: false, message: "No valid box_uid" });
    const custRow = enrichedBoxes[0];

    const updatedRows = await incrementDownloadCountBulk(uids, req.user.id);

    await insertDownloadLog({
      ...pickStickerLogFields(custRow),
      packing_number: packingNo,
      box_uid: null,
      downloaded_by: req.user.id,
      download_type: "bulk_pack",
      sticker_count: uids.length,
      download_source,
    });

    await logActivity(req, {
      action: "bulk_download",
      entity: BOX_ACTIVITY_ENTITY,
      entity_id: packingNo,
      meta: { sticker_count: uids.length },
    });

    res.json({
      success: true,
      message: `${uids.length} sticker download(s) logged (one bulk log entry with counts)`,
      data: updatedRows,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const renderSingleSticker = async (req, res) => {
  try {
    const { box_uid: boxUidRaw, sticker_meta = {}, device_type = "desktop" } = req.body;
    const download_source = normalizeStickerDownloadSource(req.body.download_source);

    const box_uid = Number(boxUidRaw);
    if (!Number.isFinite(box_uid) || box_uid <= 0)
      return res.status(400).json({ success: false, message: "box_uid required" });

    if (device_type !== "desktop")
      return res.status(400).json({ success: false, message: "Sticker print allowed only laptop/computer." });

    const box = await findBoxDetailed({ box_uid });

    if (!box)
      return res.status(404).json({ success: false, message: "Box not found" });

    const [enrichedBox] = await enrichBoxRowsFromIMS(box ? [box] : []);
    const clientPackingCustomerLocked =
      sticker_meta?.acc_code != null && String(sticker_meta.acc_code).trim() !== "";
    const packingMeta = await resolvePackingStickerMetaForPrint(enrichedBox?.packing_number, {
      ...sticker_meta,
      itemdcode: sticker_meta.itemdcode ?? enrichedBox?.itemdcode,
      acc_code: clientPackingCustomerLocked
        ? String(sticker_meta.acc_code).trim()
        : sticker_meta.acc_code ??
          enrichedBox?.override_cust ??
          enrichedBox?.acc_code ??
          enrichedBox?.prod_acc_code,
      acc_name: sticker_meta.acc_name ?? enrichedBox?.acc_name,
      sa_id: enrichedBox?.sa_id,
    });
    const hasClientStickerMeta =
      sticker_meta &&
      typeof sticker_meta === "object" &&
      Object.keys(sticker_meta).length > 0;
    const printRow = mergeStickerPrintRow(
      enrichedBox,
      hasClientStickerMeta ? { ...packingMeta, ...sticker_meta } : packingMeta,
      enrichedBox?.packing_number ?? sticker_meta?.packing_number ?? sticker_meta?.doc_no
    );
    const card = await buildStickerCardHtml(printRow);
    const printPackingNo = resolveStickerPackingNumber(printRow, enrichedBox?.packing_number);

    await insertDownloadLog({
      box_uid,
      ...pickStickerLogFields(enrichedBox, box),
      downloaded_by: req.user.id,
      download_type: "single",
      download_source,
    });

    await incrementDownloadCount(box_uid, req.user.id);

    const print_title = buildStickerPrintDocumentTitle(printPackingNo);
    res.json({
      success: true,
      html: buildPrintDocument([card], { packing_number: printPackingNo }),
      print_title,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const renderBulkStickers = async (req, res) => {
  try {
    const { packing_number, box_uids = [], sticker_meta = {}, device_type = "desktop" } = req.body;
    const download_source = normalizeStickerDownloadSource(req.body.download_source);

    if (!packing_number && !box_uids.length)
      return res.status(400).json({ success: false, message: "packing_number or box_uids is required" });

    if (device_type !== "desktop")
      return res.status(400).json({ success: false, message: "Sticker print allowed only laptop/computer" });

    const boxes = box_uids.length ? await findBoxesDetailed({ box_uids }) : await findBoxesDetailed({ packing_number });

    if (!boxes.length)
      return res.status(404).json({ success: false, message: "No boxes found for print" });

    const enrichedBoxes = await enrichBoxRowsFromIMS(boxes);
    const totalBoxes = enrichedBoxes.length;

    const packingNo = String(
      (packing_number != null && String(packing_number).trim() !== "" ? packing_number : null) ??
        enrichedBoxes[0]?.packing_number ??
        ""
    ).trim();
    if (!packingNo) {
      return res.status(400).json({ success: false, message: "packing_number required for bulk log" });
    }

    const uids = enrichedBoxes.map((b) => Number(b.box_uid)).filter((n) => Number.isFinite(n) && n > 0);
    if (!uids.length) {
      return res.status(400).json({ success: false, message: "No valid box_uid for bulk print" });
    }
    const custRow = enrichedBoxes[0];
    const packingMeta = await resolvePackingStickerMetaForPrint(packingNo, {
      ...packingLevelStickerHints(sticker_meta),
      itemdcode: sticker_meta.itemdcode ?? custRow?.itemdcode,
      acc_code: sticker_meta.acc_code ?? custRow?.prod_acc_code ?? null,
      acc_name: sticker_meta.acc_name ?? undefined,
      sa_id: custRow?.sa_id,
    });
    const hasClientStickerMeta =
      sticker_meta &&
      typeof sticker_meta === "object" &&
      Object.keys(sticker_meta).length > 0;
    const sharedPackingMeta = hasClientStickerMeta
      ? { ...packingMeta, ...packingLevelStickerHints(sticker_meta) }
      : packingMeta;

    const packingAcc =
      sharedPackingMeta.acc_code != null && String(sharedPackingMeta.acc_code).trim() !== ""
        ? String(sharedPackingMeta.acc_code).trim()
        : null;
    const packingAccName =
      sharedPackingMeta.acc_name != null && String(sharedPackingMeta.acc_name).trim() !== ""
        ? String(sharedPackingMeta.acc_name).trim()
        : null;

    const clientPackingCustomerLocked =
      sticker_meta?.acc_code != null && String(sticker_meta.acc_code).trim() !== "";

    const cards = await Promise.all(
      enrichedBoxes.map(async (box, idx) => {
        const overridden = isBoxCustomerOverridden(box.override_cust, packingAcc);
        const acc_code = clientPackingCustomerLocked
          ? packingAcc ?? box.acc_code
          : overridden
            ? effectiveBoxCustomerAcc(box.override_cust, packingAcc) ?? box.acc_code
            : packingAcc ?? box.acc_code;
        const acc_name = clientPackingCustomerLocked
          ? packingAccName ?? box.acc_name
          : overridden
            ? box.acc_name
            : packingAccName ?? box.acc_name;
        const party_rate_cust_code = acc_code
          ? await resolvePartyRateCustCodeFromIms({
              itemdcode: box.itemdcode ?? sharedPackingMeta.itemdcode,
              item_code: box.item_code ?? sharedPackingMeta.item_code,
              acc_code,
            })
          : null;
        const perBoxMeta = {
          ...sharedPackingMeta,
          acc_code,
          acc_name,
          party_rate_cust_code:
            party_rate_cust_code != null && String(party_rate_cust_code).trim() !== ""
              ? String(party_rate_cust_code).trim()
              : sharedPackingMeta.party_rate_cust_code,
        };
        return buildStickerCardHtml(
          mergeStickerPrintRow(
            { ...box, box_no: idx + 1, total_boxes: totalBoxes },
            perBoxMeta,
            packingNo
          )
        );
      })
    );

    await incrementDownloadCountBulk(uids, req.user.id);

    await insertDownloadLog({
      ...pickStickerLogFields(custRow),
      packing_number: packingNo,
      box_uid: null,
      downloaded_by: req.user.id,
      download_type: "bulk_pack",
      sticker_count: totalBoxes,
      download_source,
    });

    const print_title = buildStickerPrintDocumentTitle(packingNo);
    res.json({
      success: true,
      html: buildPrintDocument(cards, { packing_number: packingNo }),
      print_title,
      total: cards.length,
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /box/sticker/override-cust
// Body: { box_uid, new_cust }
export const overrideCustomer = async (req, res) => {
  try {
    const { box_uid, new_cust } = req.body;
    if (!box_uid || !new_cust)
      return res.status(400).json({ success: false, message: "box_uid and new_cust are required" });

    const existing = await findBox({ box_uid });
    if (!existing)
      return res.status(404).json({ success: false, message: "Box not found" });
    if (!isBoxEligibleForOverrideCustomer(existing)) {
      return res.status(400).json({
        success: false,
        message: overrideCustomerScanRejectMessage(existing),
      });
    }

    const [updated] = await updateBoxes(
      { override_cust: new_cust, updated_by: req.user.id, updated_at: new Date() },
      { box_uid }
    );

    logOverrideCustomerBatch({
      user_id: req.user.id,
      boxes: [existing],
      from_customer: existing.override_cust ?? existing.prod_acc_code,
      to_customer: new_cust,
    });

    await logActivity(req, {
      action: "override_customer",
      entity: OVERRIDE_ACTIVITY_ENTITY,
      entity_id: box_uid,
      record: existing,
      details: {
        packing_number: existing.packing_number,
        from_customer: existing.override_cust ?? existing.prod_acc_code ?? null,
        to_customer: new_cust,
        box_count: 1,
        box_uids: [box_uid],
      },
    });

    res.json({
      success : true,
      message : `Customer updated: ${existing.override_cust} → ${new_cust}`,
      data    : stripBoxAuditFromClientPayload(updated)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /box/sticker/download-history
// Body: { box_uid }
export const getBoxDownloadHistory = async (req, res) => {
  try {
    const { box_uid } = req.body;
    if (!box_uid)
      return res.status(400).json({ success: false, message: "box_uid required" });

    const data = await getDownloadLogByBox(box_uid);
    res.json({ success: true, data: data.map(stripDownloadLogResponse), total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /box/sticker/download-summary
// Body: { packing_number }
export const getPackingDownloadSummary = async (req, res) => {
  try {
    const { packing_number } = req.body;
    if (!packing_number)
      return res.status(400).json({ success: false, message: "packing_number required" });

    const pn = String(packing_number).trim();
    const [data, sa_adjustment_boxes_exist] = await Promise.all([
      getDownloadSummaryByPacking(pn),
      checkSaStockInBoxesExist(pn),
    ]);
    res.json({
      success: true,
      data: data.map(stripDownloadSummaryRow),
      total: data.length,
      sa_adjustment_boxes_exist,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const stickerManagementList = async (req, res) => {
  try {
    const { page, limit = 100, filters, sortBy, order, search, isExport } = extractListParams(req.body, { sortBy: "last_downloaded_at", order: "DESC" });
    const list_mode = req.body?.list_mode;
    const mode = String(list_mode || "log").toLowerCase();

    const result = await getStickerManagementList({
      filters: sanitizeFilters(filters, BOX_STORE_FILTER_FIELDS),
      search: mode === "box" ? sanitizeSearch(search) : undefined,
      sort: { by: sortBy, order },
      page: isExport === "true" ? 1 : page,
      limit: isExport === "true" ? 100000 : limit,
      list_mode,
    });
    const rows =
      mode === "box"
        ? await enrichStickerManagementListRows(result.data || [])
        : result.data || [];
    const { data, ...rest } = result;
    return res.json({ success: true, ...rest, data: stripBoxRowsForClient(rows) });
  } catch (err) {
    return res.status(500).json({success: false, message: err.message });
  }
};

export const listOverrideRequests = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = req.body;
    const result = await listOverrideRequestsQuery({
      filters,
      search,
      sort: { by: sortBy, order },
      page,
      limit,
    });
    const enriched = await enrichOverrideCustomerListRows(result.data || []);
    res.json({ success: true, ...result, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createOverrideRequest = async (req, res) => {
  try {
    const { status, body } = await createOverrideCustomerRequest(req);
    res.status(status).json(body);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateOverrideRequest = async (req, res) => {
  try {
    const { status, body } = await updateOverrideCustomerRequest(req);
    res.status(status).json(body);
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const approveOverrideRequest = async (req, res) => {
  try {
    const { status, body } = await approveOverrideCustomerRequest(req);
    res.status(status).json(body);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
