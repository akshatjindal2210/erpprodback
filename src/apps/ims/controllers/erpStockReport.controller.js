import { findErpStockComparisonReport } from "../utils/erp-stock-report/erpStockComparisonList.js";
import { extractListParams } from "../../core/utils/queryHelper.js";

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
