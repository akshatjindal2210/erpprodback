import { fetchFromIMS } from "../services/ims.service.js";
import { canonicalCode } from "./imsLookup.js";

function isApprovedPartyRateRow(r) {
  const status = String(r.ITAPV ?? r.ItApv ?? r.itapv ?? "").trim().toUpperCase();
  return status === "APPROVED";
}

function buildItemByDcodeMap(items = []) {
  const map = new Map();
  for (const row of items || []) {
    const dcode = canonicalCode(row.ItemDcode ?? row.Itemdcode ?? row.itemdcode);
    if (dcode) map.set(dcode, row);
  }
  return map;
}

function itemCodeUpper(row) {
  const code = row?.Item_Code ?? row?.item_code ?? row?.item_code_row;
  return code ? String(code).trim().toUpperCase() : null;
}

/** Match party-rate row to packing item — primary key is itemdcode (e.g. 441). */
function partyRateRowMatchesItem(r, itemToken, itemByDcode, targetItemCodeUpper) {
  const rowItemdcode = canonicalCode(r.ItemDcode ?? r.Itemdcode ?? r.itemdcode);
  if (rowItemdcode && rowItemdcode === itemToken) return true;
  if (!targetItemCodeUpper) return false;

  const inlineCode = r.item_code ?? r.Item_Code;
  const inlineUpper = inlineCode ? String(inlineCode).trim().toUpperCase() : null;
  if (inlineUpper && inlineUpper === targetItemCodeUpper) return true;

  const resolvedUpper = rowItemdcode ? itemCodeUpper(itemByDcode.get(rowItemdcode)) : null;
  return resolvedUpper != null && resolvedUpper === targetItemCodeUpper;
}

function resolvePartyRateAccName(r, acc, ledgerByCode) {
  const fromRow = r.acc_name ?? r.Acc_Name ?? null;
  if (fromRow != null && String(fromRow).trim() !== "") return String(fromRow).trim();
  const ledger = ledgerByCode.get(acc);
  const fromLedger = ledger?.acc_name ?? ledger?.Acc_Name ?? null;
  if (fromLedger != null && String(fromLedger).trim() !== "") return String(fromLedger).trim();
  return acc;
}

/** IMS ledger whose display name is exactly "Market" (case-insensitive). */
export function findMarketCustomerAccCode(ledgers = []) {
  for (const l of ledgers || []) {
    const name = String(l.acc_name ?? l.Acc_Name ?? "").trim();
    if (name.toLowerCase() === "market") {
      return canonicalCode(l.acc_code ?? l.Acc_Code);
    }
  }
  return null;
}

/**
 * Approved Customer Item Code rows for one item (IMS custcode / party-rates list)
 * plus IMS "Market" ledger — same source as `/master/party-rates/list`.
 */
export async function listPackingEntryCustomersForItem(itemdcode, ledgers = []) {
  const itemToken = canonicalCode(itemdcode);
  const byAcc = new Map();

  const ledgerByCode = new Map();
  for (const l of ledgers || []) {
    const code = canonicalCode(l.acc_code ?? l.Acc_Code);
    if (code) ledgerByCode.set(code, l);
  }

  const marketAcc = findMarketCustomerAccCode(ledgers);
  if (marketAcc) {
    byAcc.set(marketAcc, {
      acc_code: marketAcc,
      acc_name: resolvePartyRateAccName({}, marketAcc, ledgerByCode),
    });
  }

  if (!itemToken) return [...byAcc.values()];

  const [partyRates, items] = await Promise.all([fetchFromIMS("custcode"), fetchFromIMS("item")]);
  const itemByDcode = buildItemByDcodeMap(items);
  const targetItemCodeUpper = itemCodeUpper(itemByDcode.get(itemToken));

  for (const r of partyRates || []) {
    if (!isApprovedPartyRateRow(r)) continue;
    if (!partyRateRowMatchesItem(r, itemToken, itemByDcode, targetItemCodeUpper)) continue;

    const acc = canonicalCode(r.Acc_code ?? r.Acc_Code ?? r.acc_code);
    if (!acc || byAcc.has(acc)) continue;

    byAcc.set(acc, {
      acc_code: acc,
      acc_name: resolvePartyRateAccName(r, acc, ledgerByCode),
    });
  }

  return [...byAcc.values()];
}

const PARTY_RATE_ACC_NAME_TTL_MS = Math.max(60_000, Number(process.env.IMS_MAPS_CACHE_MS) || 300_000);
let partyRateAccNameCache = null;
let partyRateAccNameCacheAt = 0;

/** acc_code + itemdcode → acc_name from IMS custcode (party-rates). */
export async function buildPartyRateAccNameMap() {
  const now = Date.now();
  if (partyRateAccNameCache && now - partyRateAccNameCacheAt < PARTY_RATE_ACC_NAME_TTL_MS) {
    return partyRateAccNameCache;
  }

  const partyRates = await fetchFromIMS("custcode");
  const map = new Map();
  for (const r of partyRates || []) {
    const acc = canonicalCode(r.Acc_code ?? r.Acc_Code ?? r.acc_code);
    const item = canonicalCode(r.ItemDcode ?? r.Itemdcode ?? r.itemdcode);
    if (!acc || !item) continue;
    const name = r.acc_name ?? r.Acc_Name ?? null;
    if (name == null || String(name).trim() === "") continue;
    const key = `${acc}__${item}`;
    if (!map.has(key)) map.set(key, String(name).trim());
  }
  partyRateAccNameCache = map;
  partyRateAccNameCacheAt = now;
  return map;
}

export function lookupPartyRateAccName(map, accCode, itemDcode) {
  const acc = canonicalCode(accCode);
  const item = canonicalCode(itemDcode);
  if (!acc || !item || !(map instanceof Map)) return null;
  return map.get(`${acc}__${item}`) ?? null;
}

/** First party-rate acc_name for acc_code when itemdcode is unknown. */
export function lookupPartyRateAccNameAnyItem(map, accCode) {
  const acc = canonicalCode(accCode);
  if (!acc || !(map instanceof Map)) return null;
  const prefix = `${acc}__`;
  for (const [key, name] of map.entries()) {
    if (key.startsWith(prefix) && name) return name;
  }
  return null;
}

export async function findPackingEntryCustomerByAccCode(itemdcode, accCode, ledgers = []) {
  const token = canonicalCode(accCode);
  if (!token) return null;
  const rows = await listPackingEntryCustomersForItem(itemdcode, ledgers);
  return rows.find((row) => canonicalCode(row.acc_code) === token) ?? null;
}

export async function collectAccCodesForItemCustomers(itemdcode, ledgers = []) {
  const rows = await listPackingEntryCustomersForItem(itemdcode, ledgers);
  return new Set(rows.map((row) => canonicalCode(row.acc_code)).filter(Boolean));
}

export function filterLedgersForItemCustomers(ledgers = [], accCodes) {
  const allowed = accCodes instanceof Set ? accCodes : new Set(accCodes || []);
  return (ledgers || []).filter((ledger) => {
    const acc = canonicalCode(ledger.acc_code);
    return acc && allowed.has(acc);
  });
}
