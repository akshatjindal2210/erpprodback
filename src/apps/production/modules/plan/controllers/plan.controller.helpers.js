import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { calcJobCardProductionTime, shiftsForMachine } from "../../jc/jobCardProductionTime.js";
import { findPrimeProcess } from "../../jc/models/jobCard.model.js";
import { parseProcessPlan } from "../../jc/processPlanStatus.js";
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

/** One production-time calc per JC; each plan row gets that machine’s shifts. */
async function attachEstShifts(rows = []) {
  const cache = new Map();
  for (const row of rows) {
    const key = Number(row.job_card_docno) || String(row.pjobcardno || "");
    if (!key) {
      row.est_shifts = null;
      continue;
    }
    if (!cache.has(key)) {
      let est = null;
      try {
        const stages = await findPrimeProcess(Number(row.itemdcode));
        if (stages?.length) {
          est = calcJobCardProductionTime({
            qty: Number(row.qty) || 0,
            stages,
            process_plan: parseProcessPlan(row.process_plan),
          });
        }
      } catch {
        est = null;
      }
      cache.set(key, est);
    }
    row.est_shifts = shiftsForMachine(cache.get(key), row.maccode, row.stage_no);
  }
  return rows;
}

/** Plan lines for API / JC drawer — DB rows + IMS prime item labels + est_shifts. */
export async function listPlanningTableRows(jcDocno, filters = {}) {
  const rows = await listPlanRows(jcDocno, filters);
  if (!rows.length) return rows;
  const { itemMap } = await getImsMapsSafe();
  return attachEstShifts(enrichPlanRows(rows, itemMap));
}
