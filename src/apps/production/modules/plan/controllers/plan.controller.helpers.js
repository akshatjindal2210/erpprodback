import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { listPlanRows } from "../models/plan.model.js";

function primeItemFromMap(itemMap, itemdcode) {
  const dcode = Number(itemdcode);
  if (!dcode) {
    return { prime_item_dcode: null, prime_item_code: null, prime_item_desc: null };
  }
  const info = itemMap.get(canonicalCode(dcode)) || {};
  return {
    prime_item_dcode: dcode,
    prime_item_code: info.item_code || String(dcode),
    prime_item_desc: info.item_desc ?? null,
  };
}

/** Attach prime item code/desc from IMS (prod_jc.itemdcode). */
export function enrichPlanRows(rows = [], itemMap) {
  return rows.map((r) => ({ ...r, ...primeItemFromMap(itemMap, r.itemdcode) }));
}

/** Plan lines for API / JC drawer — DB rows + IMS prime item labels. */
export async function listPlanningTableRows(jcDocno) {
  const rows = await listPlanRows(jcDocno);
  if (!rows.length) return rows;
  const { itemMap } = await getImsMapsSafe();
  return enrichPlanRows(rows, itemMap);
}
