/**
 * Inventory report enrich — filter dropdowns + export fallback.
 * List view: SQL already has local names; only fill rare gaps + format doc_dt.
 */

import { canonicalCode, getImsMapsSafe } from "../erp-api/imsLookup.js";
import { fetchDailyprodDocMetaByPackings } from "../../models/inventoryInward.model.js";
import { getProductionStickerPanelMetaByPackingNumbers } from "../../models/box.model.js";
import { fetchFromIMS, fetchPackRowsForFinancialYearDoc } from "../../services/ims.service.js";
import {
  findImsPackByDocNo,
  buildImsDocFilterMany,
  imsPackRowToProduction,
} from "../erp-api/imsPackRow.js";
import { buildPartyRateAccNameMap, lookupPartyRateAccName, lookupPartyRateAccNameAnyItem } from "../packing-entry/packingEntryCustomers.js";
import { normalizeDocDtForDb } from "../packing-entry/packRowParse.js";
import { findCustomerHintsForPackings } from "./customerHints.js";
import { findDocDateHintsForPackings } from "./docDateHints.js";

const FILTER_OPTION_FIELDS = new Set(["items", "customers", "locations", "packings"]);

function isMissingDocDt(value) {
  return value == null || String(value).trim() === "";
}

function formatDocDt(raw) {
  if (isMissingDocDt(raw)) return null;
  return normalizeDocDtForDb(raw);
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

async function fetchImsCustomerCodesBatched(packingNumbers = [], map) {
  if (!packingNumbers.length) return;

  const CHUNK = 35;
  for (let i = 0; i < packingNumbers.length; i += CHUNK) {
    const chunk = packingNumbers.slice(i, i + CHUNK);
    try {
      const filter = buildImsDocFilterMany(chunk);
      if (!filter) continue;
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
  }
}

async function applyPanelDocDates(packingNumbers, map) {
  if (!packingNumbers.length) return;
  try {
    const hints = await findDocDateHintsForPackings(packingNumbers);
    for (const row of hints || []) {
      const pn = String(row.packing_number ?? "").trim();
      if (!pn || lookupPackMetaMap(map, pn)) continue;
      const formatted = formatDocDt(row.doc_dt);
      if (formatted) setPackMetaMap(map, pn, formatted);
    }
  } catch {
    /* optional */
  }
  const stillMissing = packingNumbers.filter((pn) => !lookupPackMetaMap(map, String(pn).trim()));
  if (!stillMissing.length) return;
  try {
    const panelMap = await getProductionStickerPanelMetaByPackingNumbers(stillMissing);
    for (const pn of stillMissing) {
      const entry = lookupPackMetaMap(panelMap, pn);
      const formatted = formatDocDt(entry?.dailyprod_doc_dt);
      if (formatted) setPackMetaMap(map, pn, formatted);
    }
  } catch {
    /* optional */
  }
}

/** doc_dt: SA → ims_stock_adjustment; production → ims_dailyprod; then IMS fallback. */
export async function resolvePackDocDateMap(packingNumbers = [], { localOnly = false } = {}) {
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

  if (localOnly || !stillNeed.length) {
    if (localOnly && stillNeed.length) {
      await applyPanelDocDates(stillNeed, map);
    }
    return map;
  }

  const CHUNK = 35;
  try {
    for (let i = 0; i < stillNeed.length; i += CHUNK) {
      const chunk = stillNeed.slice(i, i + CHUNK);
      const filter = buildImsDocFilterMany(chunk);
      if (!filter) continue;
      const recs = await fetchFromIMS("pack", filter);
      for (const pn of chunk) {
        if (lookupPackMetaMap(map, pn)) continue;
        const packRow = findImsPackByDocNo(recs, pn);
        if (!packRow) continue;
        const formatted = formatDocDt(imsPackRowToProduction(packRow)?.doc_dt);
        if (formatted) setPackMetaMap(map, pn, formatted);
      }
    }
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
      /* optional */
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
            const formatted = formatDocDt(imsPackRowToProduction(first)?.doc_dt);
            if (formatted) setPackMetaMap(map, pn, formatted);
          } catch {
            /* optional */
          }
        })
      );
    } catch {
      /* optional */
    }
  }

  return map;
}

function isMissingCustomerCode(code) {
  if (code == null) return true;
  const s = String(code).trim();
  return s === "" || s === "—" || s === "null";
}

function isMissingItemCode(code) {
  if (code == null) return true;
  const s = String(code).trim();
  return s === "" || s === "—" || s === "null";
}

function isPlaceholderLabel(value) {
  if (value == null) return true;
  const s = String(value).trim();
  return s === "" || s === "—";
}

function itemFromMap(itemMap, itemDcode) {
  const d = canonicalCode(itemDcode);
  return d && itemMap?.size ? itemMap.get(d) ?? null : null;
}

function ledgerName(ledgerMap, code) {
  const d = canonicalCode(code);
  return d && ledgerMap?.size ? ledgerMap.get(d) ?? null : null;
}

function toFilterIdList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  return String(val).split(",").map((v) => v.trim()).filter(Boolean);
}

export async function resolveCustomerCodeMap(packingNumbers = [], { localOnly = false } = {}) {
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

  if (localOnly) return map;

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
          /* optional */
        }
      })
    ),
    fetchImsCustomerCodesBatched(withoutFy, map),
  ]);

  return map;
}

export async function enrichInventoryFilterOptions(options = {}, { fields = null, filters = {} } = {}) {
  const requested = fields?.length
    ? fields.filter((f) => FILTER_OPTION_FIELDS.has(f))
    : [...FILTER_OPTION_FIELDS];

  const result = { items: [], customers: [], locations: [], packings: [] };

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
    const byCode = new Map();
    for (const row of options.items || []) {
      if (isMissingItemCode(row?.id) && isMissingItemCode(row?.item_code)) continue;
      const item = row?.id != null ? itemFromMap(itemMap, row.id) : null;
      const item_code = item?.item_code ?? row.item_code ?? String(row.id ?? "");
      const item_desc = item?.item_desc ?? row.item_desc ?? null;
      if (isMissingItemCode(item_code)) continue;
      const id = String(row?.id ?? item?.itemdcode ?? item_code).trim();
      if (isMissingItemCode(id)) continue;
      const key = String(item_code).trim().toUpperCase();
      if (!byCode.has(key)) {
        byCode.set(key, { id, item_code: String(item_code).trim(), item_desc });
      }
    }
    result.items = [...byCode.values()].sort((a, b) =>
      String(a.item_code || "").localeCompare(String(b.item_code || ""), undefined, {
        sensitivity: "base",
      })
    );
  }

  if (needCustomers) {  
    result.customers = (options.customers || [])
      .map((row) => {
        const id = row?.id != null ? String(row.id).trim() : "";
        if (!id || isMissingCustomerCode(id)) return null;
        const acc_name = ledgerMap.get(id) ?? id;
        return { id, acc_name };
      })
      .filter(Boolean)
      .sort((a, b) =>
        String(a.acc_name || a.id).localeCompare(String(b.acc_name || b.id), undefined, {
          sensitivity: "base",
        })
      );
  }

  if (requested.includes("locations")) result.locations = options.locations || [];
  if (requested.includes("packings")) result.packings = options.packings || [];

  return result;
}

export async function enrichInventoryRows(rows = [], { listView = false, maps: mapsIn = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  if (listView) {
    const needsIms = rows.some(
      (row) =>
        isPlaceholderLabel(row?.item_desc) ||
        isPlaceholderLabel(row?.customer_name) ||
        (row?.item_code != null &&
          canonicalCode(row.item_code) === canonicalCode(row.item_dcode))
    );

    const { itemMap, ledgerMap } = needsIms
      ? mapsIn ?? (await getImsMapsSafe())
      : { itemMap: new Map(), ledgerMap: new Map() };

    return rows.map((row) => {
      const item = itemFromMap(itemMap, row?.item_dcode);
      const itemCode =
        !isPlaceholderLabel(row?.item_code) && canonicalCode(row.item_code) !== canonicalCode(row.item_dcode)
          ? row.item_code
          : item?.item_code ?? row.item_code ?? row.item_dcode ?? "—";
      const itemDesc = !isPlaceholderLabel(row?.item_desc) ? row.item_desc : item?.item_desc ?? "—";
      const customerName = !isPlaceholderLabel(row?.customer_name)
        ? row.customer_name
        : ledgerName(ledgerMap, row?.customer_code) ?? "—";

      return {
        ...row,
        item_code: itemCode,
        item_desc: itemDesc,
        customer_name: customerName,
        doc_dt: formatDocDt(row.doc_dt) ?? null,
      };
    });
  }

  const maps = mapsIn ?? (await getImsMapsSafe());
  const { itemMap, ledgerMap } = maps;
  const emptyMap = new Map();
  const missingPackings = [
    ...new Set(
      rows
        .filter((row) => isMissingCustomerCode(row?.customer_code))
        .map((row) => String(row.packing_number ?? "").trim())
        .filter(Boolean)
    ),
  ];
  const allPackings = [...new Set(rows.map((r) => String(r.packing_number ?? "").trim()).filter(Boolean))];

  const [customerCodeMap, docDtMap, partyRateAccNameMap] = await Promise.all([
    missingPackings.length
      ? resolveCustomerCodeMap(missingPackings, { localOnly: false })
      : Promise.resolve(emptyMap),
    resolvePackDocDateMap(allPackings, { localOnly: false }).catch(() => emptyMap),
    buildPartyRateAccNameMap(),
  ]);

  return rows.map((row) => {
    const item = itemFromMap(itemMap, row?.item_dcode);
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
      : row.customer_name && String(row.customer_name).trim() !== "—"
        ? row.customer_name
        : null;

    const pn = String(row.packing_number ?? "").trim();
    const doc_dt = lookupPackMetaMap(docDtMap, pn) ?? formatDocDt(row.doc_dt) ?? null;

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
