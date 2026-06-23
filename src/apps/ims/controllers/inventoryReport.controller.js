import { sanitizeSearch } from "../../core/utils/helper.js";
import { extractListParams } from "../../core/utils/queryHelper.js";
import { enrichInventoryFilterOptions, enrichInventoryRows, findInventoryReportFiltered, getInventoryReportFilterOptions } from "../utils/inventory-report/index.js";

export const getInventoryReport = async (req, res) => {
  try {
    if (req.body?.action === "filter_options") {
      const fields = Array.isArray(req.body?.fields) ? req.body.fields : null;
      const options = await getInventoryReportFilterOptions(req.body?.filters || {}, { fields });
      const enriched = await enrichInventoryFilterOptions(options, {
        fields,
        filters: req.body?.filters || {},
      });
      return res.json({ success: true, data: enriched });
    }

    const { page, limit, filters = {}, search, sortBy, order } = extractListParams(req.body, {
      sortBy: "packing_number",
      order: "DESC",
    });

    const includeTotals = req.body?.includeTotals !== false && Number(page) === 1;

    const result = await findInventoryReportFiltered({
      search: sanitizeSearch(search),
      page,
      limit,
      sortBy,
      order,
      filters,
      includeTotals,
    });

    const enrichedRows = await enrichInventoryRows(result.data || [], { listView: true });

    res.json({
      success: true,
      data: enrichedRows,
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
