import { fetchFromIMS } from "../services/ims.service.js";

const normKey = (v) => (v == null ? null : String(v).trim());
const canonicalCode = (v) => {
  const s = normKey(v);
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isNaN(n)) return String(Math.trunc(n));
  }
  return s;
};
const keyToken = (v) => {
  const s = canonicalCode(v);
  if (!s) return null;
  return s.toUpperCase();
};

export const makePartyRateLookupKey = (acc, item) => {
  const a = keyToken(acc);
  const i = keyToken(item);
  if (!a || !i) return null;
  return `${a}__${i}`;
};
export const makePartyRateItemFallbackKey = (item) => {
  const i = keyToken(item);
  if (!i) return null;
  return `ANY__${i}`;
};

export function buildImsItemMap(items = []) {
  const map = new Map();
  for (const row of items) {
    const dcode = canonicalCode(row.ItemDcode ?? row.Itemdcode ?? row.itemdcode);
    if (!dcode) continue;
    map.set(dcode, {
      item_code: row.Item_Code ?? row.item_code ?? null,
      item_desc: row.ItemDesc ?? row.itemdesc ?? row.item_desc ?? null
    });
  }
  return map;
}

export function buildImsLedgerMap(ledgers = []) {
  const map = new Map();
  for (const row of ledgers) {
    const code = canonicalCode(row.Acc_Code ?? row.Acc_code ?? row.acc_code);
    if (!code) continue;
    map.set(code, row.Acc_Name ?? row.acc_name ?? null);
  }
  return map;
}

export async function getImsMapsSafe() {
  try {
    const [items, ledgers] = await Promise.all([fetchFromIMS("item"), fetchFromIMS("cust")]);
    return {
      itemMap: buildImsItemMap(items || []),
      ledgerMap: buildImsLedgerMap(ledgers || [])
    };
  } catch {
    return {
      itemMap: new Map(),
      ledgerMap: new Map()
    };
  }
}

export async function getImsPartyRateMapSafe() {
  try {
    const rows = await fetchFromIMS("custcode");
    const map = new Map();
    for (const r of rows || []) {
      const acc = canonicalCode(r.Acc_code ?? r.Acc_Code ?? r.acc_code);
      const item = canonicalCode(
        r.ItemDcode ?? r.Itemdcode ?? r.itemdcode ?? r.ItemCode ?? r.item_code
      );
      const status = String(r.ITAPV ?? r.ItApv ?? r.itapv ?? "").trim().toUpperCase();
      if (!acc || !item) continue;
      if (status && status !== "APPROVED") continue;
      const code = normKey(r.narr1 ?? r.Narr1 ?? null);
      if (!code) continue;
      const keys = [
        makePartyRateLookupKey(acc, item),
        makePartyRateLookupKey(acc, r.Item_Code ?? r.item_code ?? null),
      ].filter(Boolean);
      for (const key of keys) {
        if (!map.has(key)) map.set(key, code);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Account codes only — not display names. */
export function partyRateAccCandidates(...values) {
  return values.filter((x) => x != null && String(x).trim() !== "");
}

/** IMS custcode `narr1` for this customer + item only (no other-customer / item-only fallback). */
export function pickPartyRateCustCode(partyRateMap, itemCodeRaw, accCandidates = []) {
  if (!partyRateMap || itemCodeRaw == null || String(itemCodeRaw).trim() === "") return null;
  const itemToken = canonicalCode(itemCodeRaw);
  if (!itemToken) return null;
  for (const acc of accCandidates) {
    const cAcc = canonicalCode(acc);
    if (!cAcc) continue;
    const key = makePartyRateLookupKey(cAcc, itemToken);
    if (!key) continue;
    const code = partyRateMap.get(key);
    if (code) return code;
  }
  return null;
}

/** IMS party-rate narr1 for one customer acc_code + item only (no multi-customer fallback). */
export async function resolvePartyRateCustCodeFromIms({ itemdcode, item_code, acc_code }) {
  const map = await getImsPartyRateMapSafe();
  const cands = partyRateAccCandidates(acc_code);
  return (
    pickPartyRateCustCode(map, itemdcode, cands) ||
    pickPartyRateCustCode(map, item_code, cands) ||
    null
  );
}

export async function enrichRowsWithIMS(rows = [], options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const { itemCodeField = "item_dcode", accCodeField = "acc_code", itemCodeOut = "item_code", itemDescOut = "item_desc", accNameOut = "acc_name" } = options;

  const { itemMap, ledgerMap } = await getImsMapsSafe();

  return rows.map((row) => {
    const itemCode = canonicalCode(row?.[itemCodeField]);
    const accCode = canonicalCode(row?.[accCodeField]);
    const item = itemCode ? itemMap.get(itemCode) : null;
    const accName = accCode ? ledgerMap.get(accCode) : null;

    return {
      ...row,
      [itemCodeOut]: item?.item_code ?? row?.[itemCodeOut] ?? null,
      [itemDescOut]: item?.item_desc ?? row?.[itemDescOut] ?? null,
      [accNameOut]: accName ?? row?.[accNameOut] ?? null
    };
  });
}
