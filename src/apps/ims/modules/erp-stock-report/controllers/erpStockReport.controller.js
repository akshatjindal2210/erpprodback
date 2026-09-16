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

/** Push one mismatch packing to IMS stockadjust, then the report is refreshed. */
export const adjustErpStockMismatch = async (req, res) => {
  try {
    const type = String(req.user?.type || "").toLowerCase().trim();
    if (type !== "super_admin" && type !== "super admin") {
      return res.status(403).json({ success: false, message: "You do not have permission to adjust stock." });
    }
    const docno = Number(req.body?.docno);
    const docdt = String(req.body?.docdt ?? "").trim().slice(0, 10);
    const qty = Number(req.body?.qty);
    if (!Number.isFinite(docno) || docno <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(docdt) || !Number.isFinite(qty) || qty === 0) {
      return res.status(400).json({ success: false, message: "Packing no, date, and a non-zero qty are required." });
    }

    const json = await fetchImsDataRaw("stockadjust", { docno, docdt, qty }, { timeoutMs: 60000 });
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
