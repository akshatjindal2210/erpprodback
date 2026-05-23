import { findInventoryReportFiltered, getInventoryReportFilterOptions } from "../models/inventoryReport.model.js";
import { extractListParams } from "../utils/queryHelper.js";
import { sanitizeSearch } from "../utils/helper.js";
import { getImsMapsSafe } from "../utils/imsLookup.js";

async function enrichInventoryFilterOptions(options = {}) {
  const { items = [], customers = [], locations = [], packings = [] } = options;
  const { itemMap, ledgerMap } = await getImsMapsSafe();

  const enrichedItems = (items || []).map((row) => {
    const item = row?.id != null ? itemMap.get(String(row.id)) : null;
    return {
      ...row,
      item_code: item?.item_code ?? row.item_code ?? String(row.id ?? ""),
      item_desc: item?.item_desc ?? row.item_desc ?? null
    };
  });

  const enrichedCustomers = (customers || []).map((row) => ({
    ...row,
    acc_name: row?.id != null ? (ledgerMap.get(String(row.id)) ?? row.acc_name ?? String(row.id)) : (row.acc_name ?? null)
  }));

  return {
    items: enrichedItems,
    customers: enrichedCustomers,
    locations,
    packings
  };
}

async function enrichInventoryRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const { itemMap, ledgerMap } = await getImsMapsSafe();

  return rows.map((row) => {
    const item = row?.item_dcode != null ? itemMap.get(String(row.item_dcode)) : null;
    const customerName =
      row?.customer_code != null
        ? (ledgerMap.get(String(row.customer_code)) ?? row.customer_name ?? String(row.customer_code))
        : (row.customer_name ?? null);

    return {
      ...row,
      item_code: item?.item_code ?? row.item_code ?? String(row.item_dcode ?? "—"),
      item_desc: item?.item_desc ?? row.item_desc ?? "—",
      customer_name: customerName
    };
  });
}

export const getInventoryReport = async (req, res) => {
  try {
    if (req.body?.action === "filter_options") {
      const options = await getInventoryReportFilterOptions(req.body?.filters || {});
      const enriched = await enrichInventoryFilterOptions(options);
      return res.json({ success: true, data: enriched });
    }

    const { page, limit, filters = {}, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "packing_number",
      order: "DESC",
    });

    const result = await findInventoryReportFiltered({
      search: sanitizeSearch(search),
      page,
      limit,
      sortBy,
      order,
      filters,
    });

    const enrichedRows = await enrichInventoryRows(result.data || []);
    res.json({
      success: true,
      data: enrichedRows,
      totals: result.totals,
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
