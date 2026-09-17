import { findCoils, findCoilByUid } from "../models/coil.model.js";
import { findPendingStoreInForCoil } from "../../in-process-request/models/inProcessRequest.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { getStickerCompanyInfo } from "../../../../core/configuration/models/appConfig.model.js";
import { loadCoilFinderReportData, formatHumanDateTime } from "../utils/loadCoilFinderReportData.js";
import { buildCoilFinderReportDocument } from "../utils/coilFinderReportDocument.js";

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

export const getCoils = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body || {}, {
      sortBy: "coil_uid",
      order: "DESC",
    });
    const result = await findCoils({
      filters: sanitizeFilters(filters || {}, [ "mrn_uid", "mrn_id", "mrn_no", "heat_no", "in_uid", "location_id", "coil_area", "stored", "status", "item_code", "item_dcode", "from_date", "to_date", "journey", "only_stock", "pjobcardno", "macname"]),
      search: sanitizeSearch(search),
      page,
      limit,
      sortBy,
      order,
      permission: req.permission,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getCoilByUid = async (req, res) => {
  try {
    const coil_no_uid = String(req.body?.coil_no_uid || req.body?.uid || "").trim();
    if (!coil_no_uid) return res.status(400).json({ success: false, message: "Coil UID is required." });
    const data = await findCoilByUid(coil_no_uid);
    if (!data) return res.status(404).json({ success: false, message: "Coil not found." });
    const pendingStoreIn = await findPendingStoreInForCoil(data.coil_no_uid || coil_no_uid);
    return res.json({
      success: true,
      data: {
        ...data,
        pending_store_in_ipr_uid: pendingStoreIn?.ipr_uid ?? null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Coil lookup helper — same data as list/get, gated by caller module permission
 * (permission_module + permission_action in body). Use when user lacks rm_coils access.
 */
export const getCoilsViews = async (req, res) => {
  try {
    const coil_no_uid = String(req.body?.coil_no_uid || req.body?.uid || "").trim();
    if (coil_no_uid) {
      const data = await findCoilByUid(coil_no_uid);
      if (!data) return res.status(404).json({ success: false, message: "Coil not found." });
      const pendingStoreIn = await findPendingStoreInForCoil(data.coil_no_uid || coil_no_uid);
      return res.json({
        success: true,
        data: {
          ...data,
          pending_store_in_ipr_uid: pendingStoreIn?.ipr_uid ?? null,
        },
      });
    }

    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body || {}, {
      sortBy: "coil_uid",
      order: "DESC",
    });
    const result = await findCoils({
      filters: sanitizeFilters(filters || {}, [
        "mrn_uid",
        "mrn_id",
        "mrn_no",
        "heat_no",
        "in_uid",
        "location_id",
        "coil_area",
        "stored",
        "status",
        "item_code",
        "item_dcode",
        "from_date",
        "to_date",
        "journey",
        "only_stock",
        "rm_uid",
      ]),
      search: sanitizeSearch(search),
      page,
      limit,
      sortBy,
      order,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** POST { coil_no_uid } → { success, html, print_title } for browser print (QC / coil report). */
export const printCoilFinderReport = async (req, res) => {
  try {
    const body = req.body || {};
    const coil_no_uid = parseCoilUid(body);
    if (!coil_no_uid) {
      return res.status(400).json({ success: false, message: "coil_no_uid is required." });
    }

    const payload = await loadCoilFinderReportData(coil_no_uid);
    if (!payload) {
      return res.status(404).json({ success: false, message: "Coil not found." });
    }

    const html = await buildCoilFinderReportDocument({
      ...payload,
      companyInfo: await companyInfoForReport(body),
      generatedAt: formatHumanDateTime(new Date()),
    });

    return res.json({
      success: true,
      html,
      print_title: `Coil Report · ${coil_no_uid}`,
    });
  } catch (err) {
    console.error("[coil finder-report]", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to build report." });
  }
};
