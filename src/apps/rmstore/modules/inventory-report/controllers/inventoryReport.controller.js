import { findRmInventoryReport } from "../models/inventoryReport.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";

export const getInventoryReport = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "mrn_no",
      order: "DESC",
    });
    const result = await findRmInventoryReport({
      filters: sanitizeFilters(filters || {}, ["item_code", "mrn_no", "heat_no"]),
      search: sanitizeSearch(search),
      page,
      limit: limit || 10000,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[rm-inventory-report]", err);
    return res.status(500).json({
      success: false,
      message: "Could not load inventory report. Please try again.",
    });
  }
};
