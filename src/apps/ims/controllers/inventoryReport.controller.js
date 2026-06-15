import { findInventoryReportFiltered, getInventoryReportFilterOptions, findCustomerHintsForPackings } from "../models/inventoryReport.model.js";
import { fetchDailyprodDocMetaByPackings } from "../models/inventoryInward.model.js";
import { extractListParams } from "../../core/utils/queryHelper.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { getImsMapsSafe } from "../utils/imsLookup.js";
import {
  buildPartyRateAccNameMap,
  lookupPartyRateAccName,
  lookupPartyRateAccNameAnyItem,
} from "../utils/packingEntryCustomers.js";
import { fetchFromIMS, fetchPackRowsForFinancialYearDoc } from "../services/ims.service.js";
import { findImsPackByDocNo, buildImsDocFilterMany, imsPackRowToProduction } from "../utils/imsPackRow.js";
import { getProductionStickerPanelMetaByPackingNumbers } from "../models/box.model.js";

function isMissingDocDt(value) {
  return value == null || String(value).trim() === "";
}

function formatDocDt(raw) {
  if (isMissingDocDt(raw)) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return `${raw.getUTCFullYear()}-${String(raw.getUTCMonth() + 1).padStart(2, "0")}-${String(raw.getUTCDate()).padStart(2, "0")}`;
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  }
  return s;
}

function lookupPackMetaMap(map, pn) {
  const key = String(pn ?? "").trim();
  if (!key || !map?.size) return null;
  if (map.has(key)) return map.get(key);
  if (/^\d+$/.test(key) && map.has(String(Number(key)))) return map.get(String(Number(key)));
  return null;
}

function setPackMetaMap(map, pn, value) {
  const key = String(pn ?? "").trim();
  if (!key || value == null || value === "") return;
  map.set(key, value);
  if (/^\d+$/.test(key)) map.set(String(Number(key)), value);
}

/** doc_dt: local ims_dailyprod first, then IMS pack (batched + parallel). */
async function resolvePackDocDateMap(packingNumbers = []) {
  const unique = [...new Set(packingNumbers.map((p) => String(p ?? "").trim()).filter(Boolean))];
  if (!unique.length) return new Map();

  const map = new Map();
  const stillNeed = [];

  try {
    const localMeta = await fetchDailyprodDocMetaByPackings(unique);
    for (const pn of unique) {
      const meta = lookupPackMetaMap(localMeta, pn);
      const formatted = formatDocDt(meta?.doc_dt);
      if (formatted) setPackMetaMap(map, pn, formatted);
      else stillNeed.push(pn);
    }
  } catch {
    stillNeed.push(...unique.filter((pn) => !lookupPackMetaMap(map, pn)));
  }

  if (!stillNeed.length) return map;

  const CHUNK = 35;
  const chunks = [];
  for (let i = 0; i < stillNeed.length; i += CHUNK) {
    chunks.push(stillNeed.slice(i, i + CHUNK));
  }

  try {
    await Promise.all(
      chunks.map(async (chunk) => {
        const filter = buildImsDocFilterMany(chunk);
        if (!filter) return;
        const recs = await fetchFromIMS("pack", filter);
        for (const pn of chunk) {
          const packRow = findImsPackByDocNo(recs, pn);
          if (!packRow) continue;
          const prod = imsPackRowToProduction(packRow);
          const formatted = formatDocDt(prod?.doc_dt);
          if (formatted) setPackMetaMap(map, pn, formatted);
        }
      })
    );
  } catch {
    /* optional IMS */
  }

  let stillMissing = unique.filter((pn) => !lookupPackMetaMap(map, pn));
  if (stillMissing.length) {
    try {
      const panelMap = await getProductionStickerPanelMetaByPackingNumbers(stillMissing);
      for (const pn of stillMissing) {
        const entry = lookupPackMetaMap(panelMap, pn);
        const formatted = formatDocDt(entry?.dailyprod_doc_dt);
        if (formatted) setPackMetaMap(map, pn, formatted);
      }
    } catch {
      /* optional panel meta */
    }
  }

  stillMissing = unique.filter((pn) => !lookupPackMetaMap(map, pn));
  if (stillMissing.length) {
    try {
      const hints = await findCustomerHintsForPackings(stillMissing);
      const hintByPn = new Map();
      for (const row of hints || []) {
        const pn = String(row.packing_number ?? "").trim();
        if (!pn) continue;
        hintByPn.set(pn, row);
        if (/^\d+$/.test(pn)) hintByPn.set(String(Number(pn)), row);
      }
      await Promise.all(
        stillMissing.map(async (pn) => {
          if (lookupPackMetaMap(map, pn)) return;
          const hint = lookupPackMetaMap(hintByPn, pn);
          const fy = hint?.financial_year != null ? String(hint.financial_year).trim() : "";
          if (!fy) return;
          try {
            const ims = await fetchPackRowsForFinancialYearDoc(fy, pn);
            const first =
              (ims?.records || []).find((r) => {
                const raw = r?.doc_dt ?? r?.docdt ?? r?.Doc_Dt ?? r?.["Doc Dt"];
                return !isMissingDocDt(raw);
              }) ?? ims?.records?.[0];
            const prod = imsPackRowToProduction(first);
            const formatted = formatDocDt(prod?.doc_dt);
            if (formatted) setPackMetaMap(map, pn, formatted);
          } catch {
            /* optional IMS FY */
          }
        })
      );
    } catch {
      /* optional hints */
    }
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

async function fetchImsCustomerCodesBatched(packingNumbers = [], map) {
  if (!packingNumbers.length) return;

  const CHUNK = 35;
  const chunks = [];
  for (let i = 0; i < packingNumbers.length; i += CHUNK) {
    chunks.push(packingNumbers.slice(i, i + CHUNK));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const filter = buildImsDocFilterMany(chunk);
        if (!filter) return;
        const recs = await fetchFromIMS("pack", filter);
        for (const pn of chunk) {
          if (map.has(pn)) continue;
          const packRow = findImsPackByDocNo(recs, pn);
          const acc = packRow?.acc_code ?? packRow?.Acc_Code ?? packRow?.acc_Code;
          if (acc != null && String(acc).trim() !== "") {
            map.set(pn, String(acc).trim());
          }
        }
      } catch {
        /* optional IMS */
      }
    })
  );
}

/** Resolve customer acc_code for packings still missing after the report SQL. */
async function resolveCustomerCodeMap(packingNumbers = []) {
  const unique = [...new Set(packingNumbers.map((p) => String(p ?? "").trim()).filter(Boolean))];
  if (!unique.length) return new Map();

  const hints = await findCustomerHintsForPackings(unique);
  const map = new Map();
  const hintByPn = new Map();

  for (const row of hints || []) {
    const pn = String(row.packing_number ?? "").trim();
    if (!pn) continue;
    hintByPn.set(pn, row);
    const code = row.customer_code != null ? String(row.customer_code).trim() : "";
    if (code) map.set(pn, code);
  }

  const needIms = unique.filter((pn) => !map.has(pn));
  const withFy = [];
  const withoutFy = [];

  for (const pn of needIms) {
    const hint = hintByPn.get(pn);
    const fy = hint?.financial_year != null ? String(hint.financial_year).trim() : "";
    if (fy) withFy.push({ pn, fy });
    else withoutFy.push(pn);
  }

  await Promise.all([
    Promise.all(
      withFy.map(async ({ pn, fy }) => {
        try {
          const ims = await fetchPackRowsForFinancialYearDoc(fy, pn);
          const first = ims?.records?.[0];
          const acc = first?.acc_code ?? first?.Acc_Code;
          if (acc != null && String(acc).trim() !== "") {
            map.set(pn, String(acc).trim());
          }
        } catch {
          /* optional IMS */
        }
      })
    ),
    fetchImsCustomerCodesBatched(withoutFy, map),
  ]);

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

  const [customerCodeMap, docDtMap, { itemMap, ledgerMap }, partyRateAccNameMap] = await Promise.all([
    resolveCustomerCodeMap(missingPackings),
    resolvePackDocDateMap(allPackings).catch(() => new Map()),
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
    const doc_dt = lookupPackMetaMap(docDtMap, pn) ?? null;

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

    const fetchAll = req.body?.fetchAll === true;
    const includeTotals = req.body?.includeTotals !== false && (page === 1 || fetchAll);

    const result = await findInventoryReportFiltered({
      search: sanitizeSearch(search),
      page,
      limit,
      sortBy,
      order,
      filters,
      includeTotals,
      fetchAll,
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
