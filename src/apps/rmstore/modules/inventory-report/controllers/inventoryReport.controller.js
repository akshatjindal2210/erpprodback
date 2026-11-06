import { findRmInventoryReport } from "../models/inventoryReport.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { rmItemMap } from "../../production/utils/erpItems.js";
import { canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";

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
    try {
      const map = await rmItemMap();
      if (map?.size) {
        for (const row of result.data || []) {
          const item = map.get(canonicalCode(row.item_dcode));
          if (!item) continue;
          if (item.item_code) row.item_code = item.item_code;
          if (item.item_desc != null) row.item_desc = item.item_desc;
        }
      }
    } catch {}
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[rm-inventory-report]", err);
    return res.status(500).json({
      success: false,
      message: "Could not load inventory report. Please try again.",
    });
  }
};
