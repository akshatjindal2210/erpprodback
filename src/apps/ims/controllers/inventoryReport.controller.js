import { findInventoryReportFiltered, getInventoryReportFilterOptions, findCustomerHintsForPackings } from "../models/inventoryReport.model.js";
import { extractListParams } from "../../core/utils/queryHelper.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { getImsMapsSafe } from "../utils/imsLookup.js";
import { fetchFromIMS, fetchPackRowsForFinancialYearDoc } from "../services/ims.service.js";
import { findImsPackByDocNo } from "../utils/imsPackRow.js";

function isMissingCustomerCode(code) {
  if (code == null) return true;
  const s = String(code).trim();
  return s === "" || s === "—" || s === "null";
}

function buildImsDocFilter(docNo) {
  const pn = String(docNo ?? "").trim();
  const n = parseInt(pn, 10);
  return Number.isFinite(n)
    ? `dailyprod.docno = ${n}`
    : `dailyprod.docno = '${pn.replace(/'/g, "''")}'`;
}

/** Resolve customer acc_code for packings still missing after the report SQL. */
async function resolveCustomerCodeMap(packingNumbers = []) {
  const unique = [...new Set(packingNumbers.map((p) => String(p ?? "").trim()).filter(Boolean))];
  if (!unique.length) return new Map();

  const hints = await findCustomerHintsForPackings(unique);
  const map = new Map();

  for (const row of hints || []) {
    const pn = String(row.packing_number ?? "").trim();
    if (!pn) continue;
    const code = row.customer_code != null ? String(row.customer_code).trim() : "";
    if (code) map.set(pn, code);
  }

  const needIms = unique.filter((pn) => !map.has(pn));
  await Promise.all(
    needIms.map(async (pn) => {
      const hint = (hints || []).find((h) => String(h.packing_number).trim() === pn);
      const fy = hint?.financial_year != null ? String(hint.financial_year).trim() : "";

      if (fy) {
        try {
          const ims = await fetchPackRowsForFinancialYearDoc(fy, pn);
          const first = ims?.records?.[0];
          const acc = first?.acc_code ?? first?.Acc_Code;
          if (acc != null && String(acc).trim() !== "") {
            map.set(pn, String(acc).trim());
            return;
          }
        } catch {
          /* optional IMS */
        }
      }

      try {
        const recs = await fetchFromIMS("pack", buildImsDocFilter(pn));
        const packRow = findImsPackByDocNo(recs, pn);
        const acc = packRow?.acc_code ?? packRow?.Acc_Code ?? packRow?.acc_Code;
        if (acc != null && String(acc).trim() !== "") {
          map.set(pn, String(acc).trim());
        }
      } catch {
        /* optional IMS */
      }
    })
  );

  return map;
}

async function enrichInventoryFilterOptions(options = {}) {
  const { items = [], customers = [], locations = [], packings = [] } = options;
  const { itemMap, ledgerMap } = await getImsMapsSafe();

  const missingCustPackings = (customers || [])
    .filter((row) => isMissingCustomerCode(row?.id))
    .map((row) => row?.id);
  const customerCodeMap = await resolveCustomerCodeMap(missingCustPackings);

  const enrichedItems = (items || []).map((row) => {
    const item = row?.id != null ? itemMap.get(String(row.id)) : null;
    return {
      ...row,
      item_code: item?.item_code ?? row.item_code ?? String(row.id ?? ""),
      item_desc: item?.item_desc ?? row.item_desc ?? null
    };
  });

  const enrichedCustomers = (customers || []).map((row) => {
    const id = row?.id != null ? String(row.id).trim() : "";
    const resolvedId = !isMissingCustomerCode(id) ? id : (customerCodeMap.get(id) ?? id);
    return {
      ...row,
      id: resolvedId || id,
      acc_name: resolvedId
        ? (ledgerMap.get(resolvedId) ?? row.acc_name ?? resolvedId)
        : (row.acc_name ?? null)
    };
  });

  return {
    items: enrichedItems,
    customers: enrichedCustomers,
    locations,
    packings
  };
}

async function enrichInventoryRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const missingPackings = rows
    .filter((row) => isMissingCustomerCode(row?.customer_code))
    .map((row) => row.packing_number);
  const customerCodeMap = await resolveCustomerCodeMap(missingPackings);

  const { itemMap, ledgerMap } = await getImsMapsSafe();

  return rows.map((row) => {
    const item = row?.item_dcode != null ? itemMap.get(String(row.item_dcode)) : null;
    let customerCode = row?.customer_code;
    if (isMissingCustomerCode(customerCode)) {
      const pn = String(row.packing_number ?? "").trim();
      customerCode = customerCodeMap.get(pn) ?? null;
    }
    const customerName = customerCode
      ? (ledgerMap.get(String(customerCode)) ?? row.customer_name ?? String(customerCode))
      : (row.customer_name ?? null);

    return {
      ...row,
      item_code: item?.item_code ?? row.item_code ?? String(row.item_dcode ?? "—"),
      item_desc: item?.item_desc ?? row.item_desc ?? "—",
      customer_code: customerCode,
      customer_name: customerName ?? "—"
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
