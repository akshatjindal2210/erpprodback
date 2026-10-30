/** Plan table/get: DB rows + IMS labels + planLineEstimate (jobCardProductionTime.js). */
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { calcJobCardProductionTime, planLineEstimate } from "../../jc/jobCardProductionTime.js";
import { findPrimeProcess } from "../../jc/models/jobCard.model.js";
import { parseProcessPlan } from "../../jc/processPlanStatus.js";
import { listPlanRows } from "../models/plan.model.js";

function primeItemFromMap(itemMap, itemdcode) {
  const dcode = Number(itemdcode);
  if (!dcode) return { prime_item_dcode: null, prime_item_code: null, prime_item_desc: null };
  const info = itemMap.get(canonicalCode(dcode)) || {};
  return {
    prime_item_dcode: dcode,
    prime_item_code: info.item_code || String(dcode),
    prime_item_desc: info.item_desc ?? null,
  };
}

export function enrichPlanRows(rows = [], itemMap) {
  return rows.map((r) => ({ ...r, ...primeItemFromMap(itemMap, r.itemdcode) }));
}

async function jcEstimate(row, cache) {
  const key = Number(row.job_card_docno) || 0;
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let est;
  try {
    const stages = await findPrimeProcess(Number(row.itemdcode));
    est = calcJobCardProductionTime({
      qty: Number(row.qty) || 0,
      stages: stages || [],
      process_plan: parseProcessPlan(row.process_plan),
    });
  } catch (err) {
    est = { valid: false, plan_error: err?.message || "Estimate failed", qty: Number(row.qty) || 0, stages: [] };
  }
  cache.set(key, est);
  return est;
}

/** plan_qty, line_qty, est_shifts, est_hours, est_error — from jobCardProductionTime.planLineEstimate */
export async function attachPlanLineEstimates(rows = []) {
  const cache = new Map();
  for (const row of rows) {
    const est = await jcEstimate(row, cache);
    Object.assign(row, planLineEstimate(est, row.maccode, row.stage_no, row.qty));
    if (!Number(row.job_card_docno)) row.est_error = "Missing job card.";
  }
  return rows;
}

export async function listPlanningTableRows(jcDocno, filters = {}) {
  const rows = await listPlanRows(jcDocno, filters);
  if (!rows.length) return rows;
  const { itemMap } = await getImsMapsSafe();
  return attachPlanLineEstimates(enrichPlanRows(rows, itemMap));
}
