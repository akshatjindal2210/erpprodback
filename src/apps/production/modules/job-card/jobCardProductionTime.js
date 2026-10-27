/**
 * Job Card — Est. Production Time (per machine).
 *
 * Machine Master gives, per machine:
 *   speed      = pcs made in one cycle        (e.g. 100)
 *   duration   = one cycle in seconds          (e.g. 60  → 100 pcs every 1 min)
 *   setup_time = setup in seconds, once per job (e.g. 3600 → 1h)
 *
 * Formula (each selected machine, full job qty):
 *   cycles  = ceil(qty / speed)
 *   run     = cycles × duration
 *   total   = setup + run
 *   shifts  = ceil(total / SHIFT_HOURS)  ← SHIFT_HOURS in jobCard.config.js (default 8)
 *
 * Multiple Job Card (multi_jc) — see MULTI_JC_SPLIT_TIME in jobCard.config.js:
 *   false = machine-wise (default): each machine = full qty (current)
 *   true  = half-half: setup / run / total / shifts ÷ machine count
 */
import { findPrimeProcess } from "./models/jobCard.model.js";
import { MULTI_JC_SPLIT_TIME, SHIFT_HOURS } from "./jobCard.config.js";
import { buildAvailableCoilsForIssue } from "../../../rmstore/modules/issue-request/utils/stock/issueRequestCoilReserve.js";

export { SHIFT_HOURS };
const SHIFT_SECONDS = SHIFT_HOURS * 3600;

const toShifts = (seconds) => (seconds > 0 ? Math.ceil(seconds / SHIFT_SECONDS) : 0);

/** One machine making `qty` pcs → { setup, run, total, shifts } in seconds. */
function machineTime(mac, qty) {
  const speed = parseFloat(String(mac.speed ?? "").replace(/,/g, "")) || 1;
  const duration = Math.max(0, +mac.duration || 0);
  const setup_seconds = Math.max(0, +mac.setup_time || 0);

  const cycles = qty > 0 ? Math.ceil(qty / speed) : 0;
  const run_seconds = cycles * duration;
  const seconds = setup_seconds + run_seconds;

  return {
    machine_id: +mac.machine_id,
    machine_name: mac.macname || mac.name || mac.machine_label || `Machine ${mac.machine_id}`,
    machine_number: mac.number || null,
    qty,
    speed,
    duration,
    cycles,
    setup_seconds,
    run_seconds,
    seconds,
    shifts: toShifts(seconds),
  };
}

/** Snap to whole minutes — same as UI "44h 25m" lines — so top total = sum of rows. */
function finalizeMachine(m) {
  const setup_seconds = Math.floor(Math.max(0, +m.setup_seconds || 0) / 60) * 60;
  const run_seconds = Math.floor(Math.max(0, +m.run_seconds || 0) / 60) * 60;
  const seconds = setup_seconds + run_seconds;
  return { ...m, setup_seconds, run_seconds, seconds, shifts: toShifts(seconds) };
}

/**
 * true + multi_jc + 2+ machines → divide setup / run / total / shifts by machine count.
 * false → leave as calculated (current).
 */
function applyMultiJcSplit(machines, multiJc) {
  const n = machines.length;
  if (!MULTI_JC_SPLIT_TIME || !multiJc || n < 2) return machines.map(finalizeMachine);

  return machines.map((m) =>
    finalizeMachine({
      ...m,
      qty: m.qty / n,
      cycles: m.cycles / n,
      setup_seconds: m.setup_seconds / n,
      run_seconds: m.run_seconds / n,
    })
  );
}

const fail = (qty, plan_error) => ({
  valid: false,
  plan_error,
  qty,
  shift_hours: SHIFT_HOURS,
  total_seconds: null,
  shifts: null,
  stages: [],
});

/** Picked plan → { stage_no: { process_id, machine_ids, rm_item_dcodes } }. */
function picksByStage(process_plan = []) {
  const picks = {};
  for (const s of process_plan) {
    picks[+s.stage_no] = {
      process_id: +s.process_id,
      machine_ids: (s.machine_ids ?? (s.machines || []).map((m) => m.machine_id)).map(Number),
      rm_item_dcodes: (s.rm_item_dcodes ?? (s.rm_items || []).map((r) => r.rm_item_dcode)).map(Number),
    };
  }
  return picks;
}

export function calcJobCardProductionTime({ qty = 0, stages = [], process_plan = [] }) {
  const q = Math.max(0, +qty || 0);
  if (!stages.length) return fail(q, "No prime process saved for this item.");

  const picks = picksByStage(process_plan);
  const stageRows = [];
  let total_seconds = 0;
  let total_shifts = 0;

  for (const { stage_no, processes = [] } of stages) {
    const pick = picks[+stage_no] || {};
    const proc = processes.find((p) => p.process_id === pick.process_id);
    if (!proc) return fail(q, `Stage ${stage_no}: select a process.`);
    if (proc.machines?.length && !pick.machine_ids?.length) return fail(q, `Stage ${stage_no}: select a machine.`);
    if (proc.rm_items?.length && !pick.rm_item_dcodes?.length) return fail(q, `Stage ${stage_no}: select RM.`);

    const raw = pick.machine_ids
      .map((id) => proc.machines?.find((m) => +m.machine_id === id))
      .filter(Boolean)
      .map((mac) => machineTime(mac, q));

    const machines = applyMultiJcSplit(raw, Boolean(proc.multi_jc));
    // Top badge = sum of every machine line (single or multiple job card) — matches table rows.
    const stage_seconds = machines.reduce((sum, m) => sum + m.seconds, 0);
    const stage_shifts = machines.reduce((sum, m) => sum + (m.shifts || 0), 0);
    total_seconds += stage_seconds;
    total_shifts += stage_shifts;
    stageRows.push({
      stage_no,
      process_name: proc.process_name ?? null,
      multi_jc: Boolean(proc.multi_jc) && machines.length > 1,
      multi_jc_split: MULTI_JC_SPLIT_TIME && Boolean(proc.multi_jc) && machines.length > 1,
      seconds: stage_seconds,
      shifts: stage_shifts,
      machines,
    });
  }

  return {
    valid: true,
    qty: q,
    multi_jc_split_time: MULTI_JC_SPLIT_TIME,
    shift_hours: SHIFT_HOURS,
    total_seconds,
    shifts: total_shifts,
    stages: stageRows,
  };
}

/** Issuable store KG per stage (same pool as Issue Request) — attached onto estimate for UI view only. */
async function withRmAvailable(estimate, process_plan = []) {
  const plan = Array.isArray(process_plan) ? process_plan : [];
  const idsOf = (s) =>
    [...(s.rm_item_dcodes || []), ...(s.rm_items || []).map((r) => r.rm_item_dcode)]
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
  const all = [...new Set(plan.flatMap(idsOf))];
  const byDcode = {};
  await Promise.all(
    all.map(async (dcode) => {
      const r = await buildAvailableCoilsForIssue({ rm_item_dcode: dcode });
      byDcode[dcode] = +(Number(r?.store_qty) || 0).toFixed(3);
    })
  );
  const byStage = {};
  for (const s of plan) {
    const ids = idsOf(s);
    byStage[Number(s.stage_no)] = ids.length
      ? +ids.reduce((sum, id) => sum + (Number(byDcode[id]) || 0), 0).toFixed(3)
      : null;
  }
  const stages = Array.isArray(estimate?.stages) ? estimate.stages : [];
  return {
    ...estimate,
    stages: (stages.length ? stages : plan.map((s) => ({ stage_no: s.stage_no, machines: [] }))).map((st) => ({
      ...st,
      rm_available_kg: byStage[Number(st.stage_no)] ?? null,
    })),
    rm_available_by_stage: byStage,
  };
}

export async function estimateProductionForItem(itemDcode, qty, processPlan = []) {
  const stages = await findPrimeProcess(itemDcode);
  const base = !stages?.length
    ? fail(Math.max(0, +qty || 0), "No approved prime process saved for this item in Engineering → Prime Process Master.")
    : calcJobCardProductionTime({ qty, stages, process_plan: processPlan });
  return withRmAvailable(base, processPlan);
}
