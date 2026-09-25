import { findCoils, findCoilByUid } from "../models/coil.model.js";
import { findPendingStoreInForCoil } from "../../in-process-request/models/inProcessRequest.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { getStickerCompanyInfo } from "../../../../core/configuration/models/appConfig.model.js";
import { loadCoilFinderReportData, formatHumanDateTime } from "../utils/loadCoilFinderReportData.js";
import { loadCoilFinderScreenData } from "../utils/loadCoilFinderScreenData.js";
import { enrichCoilRmSpec } from "../utils/enrichCoilRmSpec.js";
import { enrichFinderCoilFg } from "../utils/enrichCoilFgFromProductionMaster.js";
import { enrichCoilFgForReassign } from "../utils/enrichCoilFgForReassign.js";
import { buildCoilFinderReportDocument } from "../utils/coilFinderReportDocument.js";

const COIL_FILTER_KEYS = [
  "mrn_uid", "mrn_id", "mrn_no", "heat_no", "in_uid", "location_id", "coil_area", "stored", "shop_floor",
  "status", "item_code", "item_dcode", "from_date", "to_date", "journey", "only_stock", "pjobcardno", "macname", "rm_uid",
];

function sanitizeCompanyInfo(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  if (raw.name != null && String(raw.name).trim()) out.name = String(raw.name).trim();
  if (raw.address != null && String(raw.address).trim()) out.address = String(raw.address).trim();
  if (raw.phone != null && String(raw.phone).trim()) out.phone = String(raw.phone).trim();
  if (raw.gstin != null && String(raw.gstin).trim()) out.gstin = String(raw.gstin).trim();
  return out;
}

function parseCoilUid(body = {}) {
  return String(body.coil_no_uid || body.uid || body.coil?.coil_no_uid || "").trim();
}

async function companyInfoForReport(body = {}) {
  const fromBody = sanitizeCompanyInfo(body.company_info || body.companyInfo);
  const fromConfig = await getStickerCompanyInfo().catch(() => ({}));
  return { ...fromConfig, ...fromBody };
}

const EMPTY_FINDER = {
  details: [],
  qcChecks: [],
  documents: [],
  transactionLogs: [],
  typeLabels: {},
};

async function loadCoilRow(coil_no_uid, { finder = false, permission = {} } = {}) {
  const uid = String(coil_no_uid || "").trim();
  if (!uid) return null;
  const data = await findCoilByUid(uid);
  if (!data) return null;

  if (!finder) {
    const pendingStoreIn = await findPendingStoreInForCoil(data.coil_no_uid || uid);
    return {
      ...data,
      pending_store_in_ipr_uid: pendingStoreIn?.ipr_uid ?? null,
    };
  }

  const coilKey = data.coil_no_uid || uid;
  const [pendingStoreIn, rmSpecPatch, finderBundle] = await Promise.all([
    findPendingStoreInForCoil(coilKey),
    enrichCoilRmSpec(data),
    loadCoilFinderScreenData(uid, permission, data),
  ]);

  const row = {
    ...data,
    ...rmSpecPatch,
    pending_store_in_ipr_uid: pendingStoreIn?.ipr_uid ?? null,
  };
  Object.assign(row, await enrichFinderCoilFg(row));
  Object.assign(row, await enrichCoilFgForReassign(row));
  row.finder = finderBundle ?? EMPTY_FINDER;
  return row;
}

function coilListQuery(body = {}, permission) {
  const { page, limit, filters, sortBy, order, search } = extractListParams(body, {
    sortBy: "coil_uid",
    order: "DESC",
  });
  return findCoils({
    filters: sanitizeFilters(filters || {}, COIL_FILTER_KEYS),
    search: sanitizeSearch(search),
    page,
    limit,
    sortBy,
    order,
    ...(permission ? { permission } : {}),
  });
}

export const getCoils = async (req, res) => {
  try {
    const result = await coilListQuery(req.body, req.permission);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getCoilByUid = async (req, res) => {
  try {
    const coil_no_uid = parseCoilUid(req.body);
    if (!coil_no_uid) return res.status(400).json({ success: false, message: "Coil UID is required." });
    const data = await loadCoilRow(coil_no_uid);
    if (!data) return res.status(404).json({ success: false, message: "Coil not found." });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /coils/helper — caller permission_module + permission_action; finder:true for Coil Finder. */
export const getCoilsViews = async (req, res) => {
  try {
    const coil_no_uid = parseCoilUid(req.body);
    if (coil_no_uid) {
      const data = await loadCoilRow(coil_no_uid, {
        finder: req.body?.finder === true,
        permission: req.permission || {},
      });
      if (!data) return res.status(404).json({ success: false, message: "Coil not found." });
      return res.json({ success: true, data });
    }
    const result = await coilListQuery(req.body);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** POST { coil_no_uid } → { success, html, print_title } for browser print (QC / coil report). */
export const printCoilFinderReport = async (req, res) => {
  try {
    const coil_no_uid = parseCoilUid(req.body);
    if (!coil_no_uid) {
      return res.status(400).json({ success: false, message: "coil_no_uid is required." });
    }

    const payload = await loadCoilFinderReportData(coil_no_uid);
    if (!payload) {
      return res.status(404).json({ success: false, message: "Coil not found." });
    }

    const html = await buildCoilFinderReportDocument({
      ...payload,
      companyInfo: await companyInfoForReport(req.body),
      generatedAt: formatHumanDateTime(new Date()),
    });

    return res.json({
      success: true,
      html,
      print_title: `RM Quality Check Report · ${coil_no_uid}`,
    });
  } catch (err) {
    console.error("[coil finder-report]", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to build report." });
  }
};
