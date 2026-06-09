import { findInventoryReportFiltered, getInventoryReportFilterOptions, findCustomerHintsForPackings } from "../models/inventoryReport.model.js";
import { extractListParams } from "../../core/utils/queryHelper.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { getImsMapsSafe } from "../utils/imsLookup.js";
import {
  buildPartyRateAccNameMap,
  lookupPartyRateAccName,
  lookupPartyRateAccNameAnyItem,
} from "../utils/packingEntryCustomers.js";
import { fetchFromIMS, fetchPackRowsForFinancialYearDoc } from "../services/ims.service.js";
import { findImsPackByDocNo, buildImsDocFilterMany } from "../utils/imsPackRow.js";

function isMissingDocDt(value) {
  return value == null || String(value).trim() === "";
}

/** IMS pack: docno → docdt (batched IMS calls to avoid timeouts). */
async function resolvePackDocDateMap(packingNumbers = []) {
  const unique = [...new Set(packingNumbers.map((p) => String(p ?? "").trim()).filter(Boolean))];
  if (!unique.length) return new Map();

  const map = new Map();
  const CHUNK = 35;

  try {
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const filter = buildImsDocFilterMany(chunk);
      if (!filter) continue;
      const recs = await fetchFromIMS("pack", filter);
      for (const pn of chunk) {
        const packRow = findImsPackByDocNo(recs, pn);
        if (!packRow) continue;
        const raw =
          packRow.docdt ??
          packRow.doc_dt ??
          packRow["Doc Dt"] ??
          packRow.Doc_Dt ??
          packRow.DocDt;
        if (!isMissingDocDt(raw)) map.set(pn, String(raw).trim());
      }
    }
  } catch {
    /* optional IMS */
  }

  return map;
}

function isMissingCustomerCode(code) {
  if (code == null) return true;
  const s = String(code).trim();
  return s === "" || s === "—" || s === "null";
}

function toFilterIdList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  return String(val).split(",").map((v) => v.trim()).filter(Boolean);
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

const FILTER_OPTION_FIELDS = new Set(["items", "customers", "locations", "packings"]);

async function enrichInventoryFilterOptions(options = {}, { fields = null, filters = {} } = {}) {
  const requested = fields?.length
    ? fields.filter((f) => FILTER_OPTION_FIELDS.has(f))
    : [...FILTER_OPTION_FIELDS];

  const result = {
    items: [],
    customers: [],
    locations: [],
    packings: [],
  };

  const needItems = requested.includes("items");
  const needCustomers = requested.includes("customers");
  let itemMap;
  let ledgerMap;

  if (needItems || needCustomers) {
    const maps = await getImsMapsSafe();
    itemMap = maps.itemMap;
    ledgerMap = maps.ledgerMap;
  }

  if (needItems) {
    result.items = (options.items || []).map((row) => {
      const item = row?.id != null ? itemMap.get(String(row.id)) : null;
      return {
        ...row,
        item_code: item?.item_code ?? row.item_code ?? String(row.id ?? ""),
        item_desc: item?.item_desc ?? row.item_desc ?? null,
      };
    });
  }

  if (needCustomers) {
    const rows = options.customers || [];
    const knownRows = rows.filter(
      (row) =>
        row?.kind === "known" ||
        (!row?.kind && row?.id != null && !isMissingCustomerCode(row.id))
    );
    const resolvePackings = [
      ...new Set(
        rows
          .filter((row) => row?.kind === "resolve" || (row?.id != null && isMissingCustomerCode(row.id)))
          .map((row) => String(row?.packing_number ?? row?.id ?? "").trim())
          .filter(Boolean)
      ),
    ];

    const customerCodeMap = resolvePackings.length
      ? await resolveCustomerCodeMap(resolvePackings)
      : new Map();

    const partyRateAccNameMap = await buildPartyRateAccNameMap();
    const itemDcodes = toFilterIdList(filters.item_dcodes);

    const resolveCustomerLabel = (code) => {
      const id = String(code ?? "").trim();
      if (!id) return null;
      const fromLedger = ledgerMap.get(id);
      if (fromLedger) return fromLedger;
      for (const itemD of itemDcodes) {
        const fromItem = lookupPartyRateAccName(partyRateAccNameMap, id, itemD);
        if (fromItem) return fromItem;
      }
      return lookupPartyRateAccNameAnyItem(partyRateAccNameMap, id);
    };

    const byId = new Map();

    /** Customers from current inventory scope only (boxes with active stock), not full DB / party-rate master. */
    for (const row of knownRows) {
      const id = row?.id != null ? String(row.id).trim() : "";
      if (!id || isMissingCustomerCode(id)) continue;
      byId.set(id, {
        id,
        acc_name: resolveCustomerLabel(id) ?? row.acc_name ?? null,
      });
    }

    for (const pn of resolvePackings) {
      const code = customerCodeMap.get(pn);
      if (!code || isMissingCustomerCode(code)) continue;
      if (!byId.has(code)) {
        byId.set(code, {
          id: code,
          acc_name: resolveCustomerLabel(code) ?? null,
        });
      }
    }

    result.customers = [...byId.values()]
      .filter((row) => row.acc_name != null && String(row.acc_name).trim() !== "")
      .sort((a, b) =>
        String(a.acc_name || a.id).localeCompare(String(b.acc_name || b.id), undefined, {
          sensitivity: "base",
        })
      );
  }

  if (requested.includes("locations")) {
    result.locations = options.locations || [];
  }
  if (requested.includes("packings")) {
    result.packings = options.packings || [];
  }

  return result;
}

export async function enrichInventoryRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const missingPackings = rows
    .filter((row) => isMissingCustomerCode(row?.customer_code))
    .map((row) => row.packing_number);
  const allPackings = [...new Set(rows.map((r) => String(r.packing_number ?? "").trim()).filter(Boolean))];

  const [customerCodeMap, docDtMap] = await Promise.all([
    resolveCustomerCodeMap(missingPackings),
    resolvePackDocDateMap(allPackings).catch(() => new Map()),
  ]);

  const [{ itemMap, ledgerMap }, partyRateAccNameMap] = await Promise.all([
    getImsMapsSafe(),
    buildPartyRateAccNameMap(),
  ]);

  return rows.map((row) => {
    const item = row?.item_dcode != null ? itemMap.get(String(row.item_dcode)) : null;
    let customerCode = row?.customer_code;
    if (isMissingCustomerCode(customerCode)) {
      const pn = String(row.packing_number ?? "").trim();
      customerCode = customerCodeMap.get(pn) ?? null;
    }
    const codeStr = customerCode != null ? String(customerCode).trim() : "";
    const customerName = codeStr
      ? ledgerMap.get(codeStr) ??
        lookupPartyRateAccName(partyRateAccNameMap, codeStr, row.item_dcode) ??
        lookupPartyRateAccNameAnyItem(partyRateAccNameMap, codeStr) ??
        (row.customer_name && String(row.customer_name).trim() !== "—" ? row.customer_name : null)
      : (row.customer_name && String(row.customer_name).trim() !== "—" ? row.customer_name : null);

    const pn = String(row.packing_number ?? "").trim();
    const doc_dt = docDtMap.get(pn) ?? null;

    return {
      ...row,
      item_code: item?.item_code ?? row.item_code ?? String(row.item_dcode ?? "—"),
      item_desc: item?.item_desc ?? row.item_desc ?? "—",
      customer_code: customerCode,
      customer_name: customerName ?? "—",
      doc_dt,
    };
  });
}

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

    const { page, limit, filters = {}, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "packing_number",
      order: "DESC",
    });

    const includeTotals = req.body?.includeTotals !== false && page === 1;

    const result = await findInventoryReportFiltered({
      search: sanitizeSearch(search),
      page,
      limit,
      sortBy,
      order,
      filters,
      includeTotals,
    });

    const enrichedRows = await enrichInventoryRows(result.data || []);
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
      error: err.message, // Add error message for debugging
    });
  }
};
