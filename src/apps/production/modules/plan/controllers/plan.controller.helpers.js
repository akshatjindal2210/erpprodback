/**
 * Plan table helpers — IMS item labels + est hours/shifts.
 */
import dbQuery from "../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../config/db/dbTables.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { calcJobCardProductionTime, planLineEstimate } from "../../jc/jobCardProductionTime.js";
import { findPrimeProcess } from "../../jc/models/jobCard.model.js";
import { netShiftHours } from "../../../../core/lib/utils/shift/shiftHours.util.js";
import { listPlanRows } from "../models/plan.model.js";

/** Sum logged run hours from prod_entry (start/end) per JC. */
async function loggedHoursByJc(pjcList = []) {
  const map = new Map();
  const list = [...new Set((pjcList || []).map((x) => String(x || "").trim()).filter(Boolean))];
  if (!list.length) return map;
  const rows = await dbQuery(
    `SELECT jc, shift_start::time AS start_time, shift_end::time AS end_time
     FROM ${T.ENTRY}
     WHERE COALESCE(is_deleted, false) = false AND jc = ANY($1::text[])`,
    [list]
  );
  for (const row of rows || []) {
    const jc = String(row.jc || "").trim();
    if (!jc) continue;
    const h = Number(netShiftHours(row.start_time, row.end_time, false).hours) || 0;
    map.set(jc, Math.round(((map.get(jc) || 0) + h) * 100) / 100);
  }
  return map;
}

export function enrichPlanRows(rows = [], itemMap) {
  return rows.map((row) => {
    const dcode = Number(row.itemdcode);
    if (!dcode) {
      return {
        ...row,
        prime_item_dcode: null,
        prime_item_code: null,
        prime_item_desc: null,
      };
    }
    const info = itemMap.get(canonicalCode(dcode)) || {};
    return {
      ...row,
      prime_item_dcode: dcode,
      prime_item_code: info.item_code || String(dcode),
      prime_item_desc: info.item_desc ?? null,
    };
  });
}

/** Add est_shifts / est_hours / logged_hours on each plan row (cache per JC). */
export async function attachPlanLineEstimates(rows = []) {
  const cache = new Map();
  const loggedMap = await loggedHoursByJc((rows || []).map((r) => r.pjobcardno || r.job_card_no));

  for (const row of rows) {
    const jcKey = Number(row.job_card_docno) || 0;
    let estimate = null;

    if (jcKey) {
      if (cache.has(jcKey)) {
        estimate = cache.get(jcKey);
      } else {
        try {
          const stages = await findPrimeProcess(Number(row.itemdcode));
          estimate = calcJobCardProductionTime({
            qty: Number(row.qty) || 0,
            stages: stages || [],
            process_plan: Array.isArray(row.process_plan) ? row.process_plan : [],
          });
        } catch (err) {
          estimate = {
            valid: false,
            plan_error: err?.message || "Estimate failed",
            qty: Number(row.qty) || 0,
            stages: [],
          };
        }
        cache.set(jcKey, estimate);
      }
    }

    Object.assign(row, planLineEstimate(estimate, row.maccode, row.stage_no, row.qty));
    const jcNo = String(row.pjobcardno || row.job_card_no || "").trim();
    row.logged_hours = jcNo ? Number(loggedMap.get(jcNo) || 0) : 0;
    if (!jcKey) row.est_error = "Missing job card.";
  }

  return rows;
}

/** Slim process_plan for board DnD — machines only, no rm_items. */
function slimProcessPlan(plan = []) {
  return (Array.isArray(plan) ? plan : []).map((s) => ({
    stage_no: s.stage_no ?? null,
    process_id: Number(s.process_id) || null,
    process_name: s.process_name || null,
    machines: (s.machines || []).map((m) => ({
      machine_id: Number(m.machine_id) || null,
      machine_name: m.machine_name || null,
    })),
  }));
}

/** Lean /plan/table row — board + table only need these fields. */
export function toPlanTableRow(row = {}) {
  const d = (v) => (v ? String(v).slice(0, 10) : null);
  return {
    docno: Number(row.docno) || null,
    pjobcardno: row.pjobcardno || null,
    job_card_docno: Number(row.job_card_docno) || null,
    itemdcode: Number(row.itemdcode) || null,
    prime_item_dcode: Number(row.prime_item_dcode ?? row.itemdcode) || null,
    prime_item_code: row.prime_item_code || null,
    prime_item_desc: row.prime_item_desc || null,
    proccode: Number(row.proccode) || null,
    process_name: row.process_name || null,
    process_deptname: row.process_deptname || null,
    maccode: row.maccode != null ? Number(row.maccode) : null,
    machine_name: row.machine_name || null,
    stage_no: row.stage_no != null ? Number(row.stage_no) : null,
    status: String(row.status || "pending").toLowerCase(),
    qty: Number(row.qty) || 0,
    plan_qty: Number(row.plan_qty ?? row.qty) || 0,
    line_qty: Number(row.line_qty ?? row.qty) || 0,
    multi_jc_split: !!row.multi_jc_split,
    jobcarddt: d(row.jobcarddt),
    mp_start: d(row.mp_start),
    mp_end: d(row.mp_end),
    sys_start: d(row.sys_start),
    sys_end: d(row.sys_end),
    /** Board/reorder: manpower if set, else system. */
    plan_start: d(row.mp_start || row.sys_start),
    plan_end: d(row.mp_end || row.sys_end),
    act_start: row.act_start || null,
    act_end: row.act_end || null,
    est_shifts: row.est_shifts != null ? Number(row.est_shifts) : null,
    est_hours: row.est_hours != null ? Number(row.est_hours) : null,
    est_setup_seconds: row.est_setup_seconds != null ? Number(row.est_setup_seconds) : null,
    est_run_seconds: row.est_run_seconds != null ? Number(row.est_run_seconds) : null,
    est_error: row.est_error || null,
    logged_hours: Math.max(0, Number(row.logged_hours) || 0),
    process_plan: slimProcessPlan(row.process_plan),
  };
}

export async function listPlanningTableRows(jcDocno, filters = {}) {
  const rows = await listPlanRows(jcDocno, filters);
  if (!rows.length) return rows;
  const { itemMap } = await getImsMapsSafe();
  const rich = await attachPlanLineEstimates(enrichPlanRows(rows, itemMap));
  return rich.map(toPlanTableRow);
}
