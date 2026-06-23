import { extractListParams } from "../../core/utils/queryHelper.js";
import { findInventoryReportFiltered } from "../utils/inventory-report/index.js";

export const getInventoryReport = async (req, res) => {
  try {
    const { page, limit, sortBy, order } = extractListParams(req.body, {
      sortBy: "packing_number",
      order: "DESC",
    });

    const includeTotals = req.body?.includeTotals !== false && Number(page) === 1;

    const result = await findInventoryReportFiltered({
      page,
      limit,
      sortBy,
      order,
      includeTotals,
    });

    res.json({
      success: true,
      data: result.data || [],
      totals: result.totals ?? null,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (err) {
    console.error("[inventory-report]", err);
    res.status(500).json({
      success: false,
      message: "Could not load inventory report. Please try again.",
    });
  }
};
