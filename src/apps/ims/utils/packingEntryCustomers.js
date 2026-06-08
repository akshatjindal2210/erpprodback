import dbQuery from "../../../config/db.js";
import { fetchFromIMS } from "../services/ims.service.js";
import { canonicalCode } from "./imsLookup.js";

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

/** Party-rate + packing-standard customers for one item, plus IMS "Market" ledger. */
export async function collectAccCodesForItemCustomers(itemdcode, ledgers = []) {
  const itemToken = canonicalCode(itemdcode);
  const codes = new Set();

  const marketAcc = findMarketCustomerAccCode(ledgers);
  if (marketAcc) codes.add(marketAcc);

  if (!itemToken) return codes;

  const partyRates = await fetchFromIMS("custcode");
  for (const r of partyRates || []) {
    const rowItem = canonicalCode(r.ItemDcode ?? r.Itemdcode ?? r.itemdcode);
    if (rowItem !== itemToken) continue;
    const acc = canonicalCode(r.Acc_code ?? r.Acc_Code ?? r.acc_code);
    if (acc) codes.add(acc);
  }

  const stdRows = await dbQuery(
    `SELECT DISTINCT acc_code::text AS acc_code
     FROM ims_packing_standard
     WHERE TRIM(item_dcode::text) = $1
       AND approved = true
       AND is_deleted = false
       AND acc_code IS NOT NULL
       AND TRIM(acc_code::text) <> ''`,
    [itemToken]
  );
  for (const row of stdRows || []) {
    const acc = canonicalCode(row.acc_code);
    if (acc) codes.add(acc);
  }

  return codes;
}

export function filterLedgersForItemCustomers(ledgers = [], accCodes) {
  const allowed = accCodes instanceof Set ? accCodes : new Set(accCodes || []);
  return (ledgers || []).filter((ledger) => {
    const acc = canonicalCode(ledger.acc_code);
    return acc && allowed.has(acc);
  });
}
