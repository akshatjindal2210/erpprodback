import { findErpStockComparisonReport } from "../utils/list/erpStockComparisonList.js";
import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";
import { fetchImsDataRaw } from "../../../lib/services/ims.service.js";

export const getErpStockComparisonReport = async (req, res) => {
  try {
    const { page, limit, sortBy, order } = extractListParams(req.body, {
      sortBy: "packing_number",
      order: "DESC",
    });
    const refresh = Boolean(req.body?.refresh);
    const refreshErp = Boolean(req.body?.refreshErp);

    const result = await findErpStockComparisonReport({
      page,
      limit,
      sortBy,
      order,
      refresh,
      refreshErp,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [], total: 0 });
  }
};

function parseStockAdjustBody(body) {
  const docno = Number(body?.docno);
  const docdt = String(body?.docdt ?? "").trim().slice(0, 10);
  const qty = Number(body?.qty);
  const fyid = Number(body?.fyid);
  if (!Number.isFinite(docno) || docno <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(docdt) || !Number.isFinite(qty) || qty === 0) {
    return { error: "Packing no, date, and a non-zero qty are required." };
  }
  if (!Number.isFinite(fyid) || fyid <= 0) {
    return { error: "fyid is required." };
  }
  return { docno, docdt, qty, fyid };
}

/** Push one mismatch packing to IMS stockadjust (type: 1 + fyid). */
export const adjustErpStockMismatch = async (req, res) => {
  try {
    const type = String(req.user?.type || "").toLowerCase().trim();
    if (type !== "super_admin" && type !== "super admin") {
      return res.status(403).json({ success: false, message: "You do not have permission to adjust stock." });
    }
    const parsed = parseStockAdjustBody(req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, message: parsed.error });
    }
    const json = await fetchImsDataRaw("stockadjust", { ...parsed, type: 1 });
    if (!json?.success) {
      return res.status(502).json({ success: false, message: json?.message || "Stock adjust failed." });
    }
    return res.json({
      success: true,
      records: Array.isArray(json.records) ? json.records : [],
      message: json.message || "Adjusted.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Stock adjust failed." });
  }
};

/** Same as Adjust, with type: 2 + fyid on stockadjust. */
export const adjustErpStockMismatch2 = async (req, res) => {
  try {
    const type = String(req.user?.type || "").toLowerCase().trim();
    if (type !== "super_admin" && type !== "super admin") {
      return res.status(403).json({ success: false, message: "You do not have permission to adjust stock." });
    }
    const parsed = parseStockAdjustBody(req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, message: parsed.error });
    }

    const json = await fetchImsDataRaw("stockadjust", { ...parsed, type: 2 });
    if (!json?.success) {
      return res.status(502).json({ success: false, message: json?.message || "Stock adjust failed." });
    }
    return res.json({
      success: true,
      records: Array.isArray(json.records) ? json.records : [],
      message: json.message || "Adjusted.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Stock adjust failed." });
  }
};
