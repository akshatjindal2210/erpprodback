/**
 * prod_plan — one row = one process + machine on a job card.
 *
 * Main flow when JC is saved:
 *   saveJobCardPlan → sync rows → apply SA status → stage-1 = planning
 */
import dbQuery from "../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T, ENGINEERING_TABLES as E } from "../../../../../config/db/dbTables.js";
import { buildProcessPlanFromPlanRows, machineStatusKey, parseProcessPlan, PROCESS_STATUS, PROCESS_STATUS_VALUES, stripPlanStatuses } from "../../jc/processPlanStatus.js";
import { calcJobCardProductionTime, machineEstForPlan } from "../../jc/jobCardProductionTime.js";
import { findPrimeProcess } from "../../jc/models/jobCard.model.js";
import { createEntry } from "../../entry/models/entry.model.js";
import { getShiftsPerDay, listActiveShiftCodes } from "./planManpower.model.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { issueQtyKg } from "../../jc/jobCard.config.js";

/** RM required KG for the JC (same formula as Maintain Job Card "RM Required"). */
async function rmQtyKgForCard(card) {
  const qty = Number(card?.planqty);
  if (!Number.isFinite(qty) || qty < 0) return null;
  try {
    const { itemMap } = await getImsMapsSafe();
    const w = Number(itemMap.get(canonicalCode(card?.itemdcode))?.gweight);
    return issueQtyKg(Number.isFinite(w) && w > 0 ? w : null, qty);
  } catch {
    return null;
  }
}

/** One RM wire for the plan row → `{ itemdcode, qty }`. */
function rmCols(stageRm, rmQty) {
  const r = (stageRm || [])[0];
  const itemdcode = Number(r?.itemdcode ?? r?.rm_item_dcode);
  return {
    itemdcode: Number.isFinite(itemdcode) && itemdcode > 0 ? itemdcode : null,
    qty: rmQty != null && Number.isFinite(Number(rmQty)) ? Number(rmQty) : null,
  };
}

/** Hold on board → one production entry for this machine / JC / current (or last) shift. */
async function createEntryOnHold(line, user) {
  const mac = Number(line?.maccode);
  const jc = String(line?.pjobcardno || "").trim();
  if (!(mac > 0) || !jc) return;

  const today = new Date();
  const ymd = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");

  const shifts = await listActiveShiftCodes();
  const hm = `${String(today.getHours()).padStart(2, "0")}:${String(today.getMinutes()).padStart(2, "0")}`;
  let shiftMeta =
    shifts.find((s) => {
      const start = String(s.start_time || "").slice(0, 5);
      const end = String(s.end_time || "").slice(0, 5);
      if (!start || !end) return false;
      if (start <= end) return hm >= start && hm <= end;
      return hm >= start || hm <= end;
    }) || shifts[shifts.length - 1] || { id: 1 };

  const [mp] = await dbQuery(
    `SELECT emp_code, emp_name FROM ${T.PLAN_MANPOWER}
     WHERE maccode = $1 AND plan_date = $2::date AND shift_no = $3
     ORDER BY id LIMIT 1`,
    [mac, ymd, Number(shiftMeta.id) || 1]
  );

  try {
    await createEntry(
      {
        jc,
        docdt: ymd,
        shift: Number(shiftMeta.id) || 1,
        machine: mac,
        run_proc: line.proccode != null ? Number(line.proccode) : null,
        operator_id: mp?.emp_code || null,
        operator: mp?.emp_name || null,
        start_time: shiftMeta.start_time || null,
        end_time: shiftMeta.end_time || null,
        hours: Number(shiftMeta.hours) > 0 ? Number(shiftMeta.hours) : null,
      },
      user || "System"
    );
  } catch {
    /* duplicate cell / validation — hold status still saved */
  }
}

const JOIN = `
  LEFT JOIN ${E.PROCESS_MASTER} pr ON pr.proccode = p.proccode AND COALESCE(pr.is_deleted, false) = false
  LEFT JOIN ${E.MACHINE_MASTER} m ON m.maccode = p.maccode AND COALESCE(m.is_deleted, false) = false`;

const LIST_SQL = `SELECT p.docno, p.pjobcardno, p.proccode, p.maccode, p.stage_no, p.status,
  p.itemdcode AS rm_itemdcode, p.qty AS rm_qty,
  p.sys_start, p.sys_end, p.act_start, p.act_end, p.mp_start, p.mp_end,
  p.created_by, p.created_by AS created_by_name, p.created_at,
  p.updated_by, p.updated_by AS updated_by_name, p.updated_at,
  pr.procname AS process_name, pr.deptname AS process_deptname, m.macname AS machine_name,
  j.docno AS job_card_docno, j.itemdcode, j.planqty AS qty,
  j.jobcarddt, j.status AS card_status
  FROM ${T.PLAN} p
  INNER JOIN ${T.JC} j ON j.pjobcardno = p.pjobcardno AND j.approved = true AND COALESCE(j.is_deleted, false) = false
  ${JOIN}`;

/** Run query — uses transaction client if given. */
async function runQuery(sql, params, client) {
  if (client) return (await client.query(sql, params)).rows;
  return dbQuery(sql, params);
}

function userName(value) {
  return String(value || "").trim() || "System";
}

function toDate(value) {
  const s = String(value || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** sys_end / mp_end from start date + how many shifts needed. */
function addShiftsToDate(startDate, shifts, shiftsPerDay = 1) {
  if (!startDate || !shifts) return startDate;
  const perDay = Math.max(1, Number(shiftsPerDay) || 1);
  const daysToAdd = Math.floor((Number(shifts) - 1) / perDay);
  const d = new Date(`${startDate}T12:00:00`);
  d.setDate(d.getDate() + daysToAdd);
  return d.toISOString().slice(0, 10);
}

function addCalendarDays(ymd, n) {
  if (!ymd) return null;
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + (Number(n) || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Set sys_start / sys_end by stage order for one JC.
 *
 *   Stage 1  → start = jobcarddt, end = start + shifts
 *   Stage 2+ → start = previous stage end + 1 day, end = start + shifts
 *              (maal stage1 se aata hai — stage2 pehle start nahi)
 *
 * Board PL.DT = COALESCE(mp_start, sys_start). Seeded / early mp on stage 2+
 * (same day as stage 1) is cleared so cascaded sys_start shows.
 */
async function cascadePlanSysDates(card, client = null) {
  const pjc = String(card?.pjobcardno || "").trim();
  const jcDate = toDate(card?.jobcarddt);
  if (!pjc || !jcDate) return;

  const rows = await runQuery(
    `SELECT docno, maccode, stage_no, mp_start, mp_end
     FROM ${T.PLAN} WHERE pjobcardno = $1
     ORDER BY stage_no NULLS LAST, docno`,
    [pjc],
    client
  );
  if (!rows.length) return;

  const shiftsPerDay = await getShiftsPerDay();
  let estimate = null;
  try {
    const prime = await findPrimeProcess(Number(card.itemdcode));
    if (prime?.length) {
      const maps = await loadProcessPlanMapsByJobCards([pjc], client);
      estimate = calcJobCardProductionTime({
        qty: Number(card.planqty) || 0,
        stages: prime,
        process_plan: maps.get(pjc) || [],
      });
    }
  } catch (_) {
    /* estimate optional */
  }

  const firstStageNo = Math.min(...rows.map((r) => Number(r.stage_no) || 1));
  let start = jcDate;
  let prevStage = null;
  let stageEnd = null;
  const now = new Date();

  for (const row of rows) {
    const stage = Number(row.stage_no) || 1;
    if (prevStage != null && stage !== prevStage) {
      start = stageEnd ? addCalendarDays(stageEnd, 1) : jcDate;
      stageEnd = null;
    }
    prevStage = stage;

    const shifts = machineEstForPlan(estimate, row.maccode, stage)?.shifts ?? estimate?.shifts;
    const end = addShiftsToDate(start, shifts, shiftsPerDay);
    if (end && (!stageEnd || end > stageEnd)) stageEnd = end;

    const mp = toDate(row.mp_start);
    const mpEnd = toDate(row.mp_end);
    /** Stage 2+ mp before cascaded start = seed / invalid — drop so PL.DT uses sys_start. */
    const wipeMp = stage > firstStageNo && !!mp && !!start && mp < start;
    /**
     * mp_end only when full stage hours are planned.
     * Same-day start=end while many shifts still needed → clear premature end.
     */
    const wipeEnd =
      wipeMp ||
      (!!mp && !!mpEnd && mpEnd === mp && (Number(shifts) || 0) > Math.max(1, shiftsPerDay));

    await runQuery(
      `UPDATE ${T.PLAN}
       SET sys_start = $2::date, sys_end = $3::date,
           mp_start = CASE WHEN $4::boolean THEN NULL ELSE mp_start END,
           mp_end   = CASE WHEN $5::boolean THEN NULL ELSE mp_end END,
           updated_at = $6
       WHERE docno = $1`,
      [row.docno, start, end, wipeMp, wipeEnd, now],
      client
    );

    /**
     * Do NOT delete prod_plan_manpower here.
     * cascadePlanSysDates runs on every /plan/table read — wiping by maccode
     * removed shared-machine bookings (and left the calendar showing stale UI).
     * Stage gates stay in FIFO + shift-op save validation instead.
     */
  }
}

function getFirstStageNo(plan) {
  const nums = parseProcessPlan(plan)
    .map((s) => Number(s.stage_no))
    .filter((n) => Number.isFinite(n));
  return nums.length ? Math.min(...nums) : 1;
}

/** Build process_plan[] map for many job cards (for list / JC helpers). */
export async function loadProcessPlanMapsByJobCards(pjobcardnos = [], client = null) {
  const nos = [...new Set((pjobcardnos || []).map((n) => String(n || "").trim()).filter(Boolean))];
  const result = new Map(nos.map((n) => [n, []]));
  if (!nos.length) return result;

  const rows = await runQuery(
    `SELECT p.pjobcardno, p.proccode, p.maccode, p.stage_no, p.status,
            p.itemdcode AS rm_itemdcode, p.qty AS rm_qty,
            pr.procname AS process_name, m.macname AS machine_name
     FROM ${T.PLAN} p ${JOIN}
     WHERE p.pjobcardno = ANY($1::text[])
     ORDER BY p.stage_no NULLS LAST, p.proccode, p.maccode`,
    [nos],
    client
  );

  const byJc = new Map();
  for (const row of rows || []) {
    const pjc = String(row.pjobcardno);
    if (!byJc.has(pjc)) byJc.set(pjc, []);
    byJc.get(pjc).push(row);
  }
  for (const [pjc, jcRows] of byJc) {
    result.set(pjc, buildProcessPlanFromPlanRows(jcRows));
  }
  return result;
}

export async function jobCardHasPlan(pjobcardno, client = null) {
  const pjc = String(pjobcardno || "").trim();
  if (!pjc) return false;
  const [row] = await runQuery(
    `SELECT 1 AS ok FROM ${T.PLAN} WHERE pjobcardno = $1 LIMIT 1`,
    [pjc],
    client
  );
  return Boolean(row);
}

/** Attach process_plan array on each plan row. */
async function attachProcessPlan(rows = []) {
  const plans = await loadProcessPlanMapsByJobCards(rows.map((r) => r.pjobcardno));
  return rows.map((r) => ({
    ...r,
    process_plan: plans.get(String(r.pjobcardno || "").trim()) || [],
  }));
}

/** Board / table list. */
export async function listPlanRows(jcDocno, filters = {}) {
  const where = [];
  const params = [];

  const jcId = Number(jcDocno);
  if (jcId) {
    params.push(jcId);
    where.push(`j.docno = $${params.length}`);
  }

  const fromDate = toDate(filters?.from_date);
  const toDateVal = toDate(filters?.to_date);
  // Effective plan date = manpower mp_* if set, else system sys_*.
  const effStart = `COALESCE(p.mp_start, p.sys_start)`;
  if (fromDate) {
    params.push(fromDate);
    where.push(`${effStart} IS NOT NULL AND ${effStart}::date >= $${params.length}::date`);
  }
  if (toDateVal) {
    params.push(toDateVal);
    where.push(`${effStart} IS NOT NULL AND ${effStart}::date <= $${params.length}::date`);
  }

  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const orderSql = `ORDER BY p.maccode NULLS LAST, ${effStart} ASC NULLS LAST, p.pjobcardno ASC, p.stage_no, p.proccode`;

  let rows = await runQuery(`${LIST_SQL}${whereSql} ${orderSql}`, params);

  // One pass: fix stage dates for each JC (idempotent).
  const done = new Set();
  for (const r of rows || []) {
    const pjc = String(r.pjobcardno || "").trim();
    if (!pjc || done.has(pjc)) continue;
    done.add(pjc);
    await cascadePlanSysDates(
      { pjobcardno: pjc, jobcarddt: r.jobcarddt, planqty: r.qty, itemdcode: r.itemdcode },
      null
    );
  }
  if (done.size) rows = await runQuery(`${LIST_SQL}${whereSql} ${orderSql}`, params);

  return attachProcessPlan(rows);
}

/**
 * Same-machine queue reorder via mp_start / mp_end (date order = board order).
 * Permutes existing date windows onto the new drag order — no queue_no.
 * Same-day ties get +1 day so top/bottom order sticks. Running → Hold first.
 */
export async function reorderMachinePlanQueue({ maccode, orderedDocnos = [], by = "System" } = {}) {
  const mac = Number(maccode);
  const ids = [...new Set((orderedDocnos || []).map(Number).filter((n) => n > 0))];
  if (!(mac > 0)) {
    const err = new Error("maccode is required.");
    err.statusCode = 400;
    throw err;
  }
  if (ids.length < 2) {
    const err = new Error("ordered_docnos needs at least 2 plan lines.");
    err.statusCode = 400;
    throw err;
  }

  const rows = await runQuery(
    `SELECT docno, pjobcardno, maccode, status, mp_start, mp_end, sys_start, sys_end
     FROM ${T.PLAN}
     WHERE maccode = $1 AND docno = ANY($2::int[])`,
    [mac, ids]
  );
  if (rows.length !== ids.length) {
    const err = new Error("Some plan lines are missing or not on this machine.");
    err.statusCode = 400;
    throw err;
  }

  if (rows.some((r) => String(r.status || "").toLowerCase() === PROCESS_STATUS.RUNNING)) {
    const err = new Error("Hold the Running job first, then reorder.");
    err.statusCode = 409;
    throw err;
  }

  const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00`);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // Effective window: mp_* if manpower planned, else sys_*.
  const effStart = (r) => toDate(r.mp_start) || toDate(r.sys_start);
  const effEnd = (r) => toDate(r.mp_end) || toDate(r.sys_end) || effStart(r);
  const spanDays = (r) => {
    const a = effStart(r);
    const b = effEnd(r);
    if (!a || !b || b < a) return 0;
    return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
  };

  const windows = [...rows]
    .sort((a, b) => {
      const da = String(effStart(a) || "");
      const db = String(effStart(b) || "");
      if (da !== db) return da.localeCompare(db);
      return Number(a.docno) - Number(b.docno);
    })
    .map((r) => ({
      mp_start: effStart(r),
      mp_end: effEnd(r),
      span: spanDays(r),
    }));

  const now = new Date();
  const user = userName(by);
  const updated = [];
  let prevStart = null;
  for (let i = 0; i < ids.length; i += 1) {
    const w = windows[i] || {};
    let mp_start = w.mp_start || new Date().toISOString().slice(0, 10);
    let mp_end = w.mp_end || mp_start;
    const span = Number.isFinite(w.span) ? w.span : 0;
    // Keep drag order when several cards share the same day.
    if (prevStart && mp_start <= prevStart) {
      mp_start = addDays(prevStart, 1);
      mp_end = addDays(mp_start, span);
    }
    prevStart = mp_start;
    const [row] = await runQuery(
      `UPDATE ${T.PLAN}
       SET mp_start = $2::date, mp_end = $3::date, updated_by = $4, updated_at = $5
       WHERE docno = $1 AND maccode = $6
       RETURNING docno, pjobcardno, maccode, status, mp_start, mp_end`,
      [ids[i], mp_start, mp_end, user, now, mac]
    );
    if (row) updated.push(row);
  }
  return updated;
}

/**
 * First stage of this JC: pending → planning.
 * So Board can show Start on new job cards.
 */
export async function ensureStage1Planning(pjobcardno, by = "System", client = null) {
  const pjc = String(pjobcardno || "").trim();
  if (!pjc) return;

  await runQuery(
    `UPDATE ${T.PLAN} p
     SET status = $2, updated_by = $3, updated_at = $4
     WHERE p.pjobcardno = $1
       AND LOWER(COALESCE(p.status, '')) = $5
       AND (
         p.stage_no = (
           SELECT MIN(p2.stage_no) FROM ${T.PLAN} p2 WHERE p2.pjobcardno = p.pjobcardno
         )
         OR (
           p.stage_no IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM ${T.PLAN} p2
             WHERE p2.pjobcardno = p.pjobcardno AND p2.stage_no IS NOT NULL
           )
         )
       )`,
    [pjc, PROCESS_STATUS.PLANNING, userName(by), new Date(), PROCESS_STATUS.PENDING],
    client
  );
}

/** When a stage is fully complete → next stage pending becomes planning. */
async function unlockNextStage(pjobcardno, doneStage, by, client = null) {
  const pjc = String(pjobcardno || "").trim();
  const stage = Number(doneStage);
  if (!pjc || !Number.isFinite(stage)) return;

  // All lines of this stage must be complete.
  const sameStage = await runQuery(
    `SELECT status FROM ${T.PLAN} WHERE pjobcardno = $1 AND stage_no = $2`,
    [pjc, stage],
    client
  );
  if (!sameStage?.length) return;
  const allDone = sameStage.every(
    (r) => String(r.status || "").toLowerCase() === PROCESS_STATUS.COMPLETE
  );
  if (!allDone) return;

  const [next] = await runQuery(
    `SELECT MIN(stage_no)::int AS stage_no FROM ${T.PLAN}
     WHERE pjobcardno = $1 AND stage_no > $2`,
    [pjc, stage],
    client
  );
  const nextStage = Number(next?.stage_no);
  if (!Number.isFinite(nextStage)) return;

  await runQuery(
    `UPDATE ${T.PLAN}
     SET status = $3, updated_by = $5, updated_at = $6
     WHERE pjobcardno = $1 AND stage_no = $2 AND LOWER(COALESCE(status, '')) = $4`,
    [pjc, nextStage, PROCESS_STATUS.PLANNING, PROCESS_STATUS.PENDING, userName(by), new Date()],
    client
  );
}

/**
 * Upsert plan rows from Maintain Job Card (structure only).
 * Dates → cascadePlanSysDates at the end.
 */
export async function syncPlanFromJobCard(card, client = null, planStages = null) {
  const pjc = String(card?.pjobcardno || "").trim();
  if (!pjc) return;

  let plan;
  if (planStages != null) {
    plan = stripPlanStatuses(planStages);
  } else {
    const maps = await loadProcessPlanMapsByJobCards([pjc], client);
    plan = stripPlanStatuses(maps.get(pjc) || []);
  }

  if (!plan.length) {
    await runQuery(`DELETE FROM ${T.PLAN} WHERE pjobcardno = $1`, [pjc], client);
    return;
  }

  const now = new Date();
  const jcDate = toDate(card.jobcarddt);
  const stage1 = getFirstStageNo(plan);
  const rmQty = await rmQtyKgForCard(card);

  const existing = await runQuery(
    `SELECT docno, proccode, maccode FROM ${T.PLAN} WHERE pjobcardno = $1`,
    [pjc],
    client
  );
  const existingByKey = new Map(
    existing.map((row) => [`${row.proccode}:${Number(row.maccode) || 0}`, row])
  );
  const keepKeys = new Set();

  for (const stage of parseProcessPlan(plan)) {
    const proccode = Number(stage.process_id);
    const stageNo = Number.isFinite(Number(stage.stage_no)) ? Number(stage.stage_no) : stage1;
    const status = stageNo === stage1 ? PROCESS_STATUS.PLANNING : PROCESS_STATUS.PENDING;
    const { itemdcode: rmItemdcode, qty: rmLineQty } = rmCols(stage.rm_items, rmQty);
    const machineIds = (stage.machines || []).length
      ? stage.machines.map((m) => Number(m.machine_id) || null)
      : [null];

    for (const maccode of machineIds) {
      const key = `${proccode}:${maccode || 0}`;
      keepKeys.add(key);
      const old = existingByKey.get(key);

      if (old) {
        // Keep status / act_* / mp_* — only structure + RM.
        await runQuery(
          `UPDATE ${T.PLAN}
           SET stage_no = $2, itemdcode = $3, qty = $4, updated_by = $5, updated_at = $6
           WHERE docno = $1`,
          [old.docno, stageNo, rmItemdcode, rmLineQty, "System", now],
          client
        );
      } else {
        await runQuery(
          `INSERT INTO ${T.PLAN}
             (pjobcardno, proccode, maccode, stage_no, status, itemdcode, qty,
              sys_start, sys_end, created_by, created_at, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'System',$9,'System',$9)`,
          [pjc, proccode, maccode, stageNo, status, rmItemdcode, rmLineQty, jcDate, now],
          client
        );
      }
    }
  }

  for (const row of existing) {
    const key = `${row.proccode}:${Number(row.maccode) || 0}`;
    if (!keepKeys.has(key)) {
      await runQuery(`DELETE FROM ${T.PLAN} WHERE docno = $1`, [row.docno], client);
    }
  }

  // Stage 1 = JC date; next stage = day after previous end.
  await cascadePlanSysDates(card, client);
}

/** Super-admin can set machine status from JC screen. */
export async function applyPlanStatusOverrides(pjobcardno, statusMap, client = null, by = "System") {
  const pjc = String(pjobcardno || "").trim();
  if (!pjc || !(statusMap instanceof Map) || !statusMap.size) return;

  const rows = await runQuery(
    `SELECT docno, proccode, maccode, status FROM ${T.PLAN} WHERE pjobcardno = $1`,
    [pjc],
    client
  );
  const now = new Date();
  const user = userName(by);

  for (const row of rows || []) {
    const key = machineStatusKey(row.proccode, row.maccode);
    if (!statusMap.has(key)) continue;

    const nextStatus = String(statusMap.get(key) || "").toLowerCase();
    if (!PROCESS_STATUS_VALUES.includes(nextStatus)) continue;
    if (nextStatus === String(row.status || "").toLowerCase()) continue;

    // Cast $2 as text everywhere — status is VARCHAR; bare $2 = 'running' deduces text vs varchar (42P08).
    // Separate $3/$5 for act_* (timestamptz) vs updated_at (timestamp).
    await runQuery(
      `UPDATE ${T.PLAN}
       SET status = $2::text,
           act_start = CASE WHEN $2::text = 'running' AND act_start IS NULL THEN $3::timestamptz ELSE act_start END,
           act_end   = CASE WHEN $2::text = 'complete' AND act_end IS NULL THEN $3::timestamptz ELSE act_end END,
           updated_by = $4,
           updated_at = $5
       WHERE docno = $1`,
      [row.docno, nextStatus, now, user, now],
      client
    );
  }
}

/**
 * Called from JC create + update.
 * 1) sync plan rows
 * 2) apply any SA status picks (often all "pending" from UI)
 * 3) force stage-1 back to planning
 */
export async function saveJobCardPlan(card, { client = null, planStages = null, statusOverrides = null, by = "System" } = {}) {
  const pjc = String(card?.pjobcardno || "").trim();
  if (!pjc) return;

  const user = userName(by);
  await syncPlanFromJobCard(card, client, planStages);
  await applyPlanStatusOverrides(pjc, statusOverrides, client, user);
  await ensureStage1Planning(pjc, user, client);
}

export async function findPlanLine(docno) {
  const id = Number(docno);
  if (!id) return null;
  const [row] = await runQuery(`${LIST_SQL} WHERE p.docno = $1`, [id]);
  if (!row) return null;
  const [withPlan] = await attachProcessPlan([row]);
  return withPlan;
}

/** Board: update dates / status / machine. */
export async function updatePlanLine(docno, patch = {}) {
  const line = await findPlanLine(docno);
  if (!line) return null;

  const oldStatus = String(line.status || PROCESS_STATUS.PENDING).toLowerCase();
  let status = oldStatus;

  if (patch.status !== undefined) {
    const next = String(patch.status || "").toLowerCase().trim();
    if (!PROCESS_STATUS_VALUES.includes(next)) {
      const err = new Error("Invalid status.");
      err.statusCode = 400;
      throw err;
    }
    // Start only from Planning or Hold.
    if (
      next === PROCESS_STATUS.RUNNING &&
      oldStatus !== PROCESS_STATUS.PLANNING &&
      oldStatus !== PROCESS_STATUS.HOLD
    ) {
      const err = new Error("Start only when status is Planning (or Hold to resume).");
      err.statusCode = 400;
      throw err;
    }
    status = next;
  }

  let maccode = line.maccode;
  if (patch.maccode !== undefined) {
    if (patch.maccode === null || patch.maccode === "") maccode = null;
    else if (Number(patch.maccode) > 0) maccode = Number(patch.maccode);
  }

  const mpStart = patch.mp_start !== undefined ? toDate(patch.mp_start) : line.mp_start;
  const mpEnd = patch.mp_end !== undefined ? toDate(patch.mp_end) : line.mp_end;
  const now = new Date();
  const user = userName(patch.updated_by || patch.by);
  const setActStart = status === PROCESS_STATUS.RUNNING && !line.act_start ? now : null;
  const setActEnd = status === PROCESS_STATUS.COMPLETE && !line.act_end ? now : null;

  const [updated] = await runQuery(
    `UPDATE ${T.PLAN}
     SET mp_start = $2,
         mp_end = $3,
         status = $4,
         maccode = $5,
         act_start = COALESCE($6, act_start),
         act_end = COALESCE($7, act_end),
         updated_by = $8,
         updated_at = $9
     WHERE docno = $1
     RETURNING docno, pjobcardno, proccode, maccode, stage_no, status,
       itemdcode AS rm_itemdcode, qty AS rm_qty,
       sys_start, sys_end, act_start, act_end, mp_start, mp_end,
       created_by, created_at, updated_by, updated_at`,
    [Number(docno), mpStart, mpEnd, status, maccode, setActStart, setActEnd, user, now]
  );

  // Completing a stage may unlock the next stage.
  if (updated && status === PROCESS_STATUS.COMPLETE && oldStatus !== PROCESS_STATUS.COMPLETE) {
    await unlockNextStage(updated.pjobcardno, updated.stage_no, user);
  }

  // Hold from Running → production entry (one step log).
  if (updated && status === PROCESS_STATUS.HOLD && oldStatus === PROCESS_STATUS.RUNNING) {
    await createEntryOnHold(updated, user);
  }

  return updated || null;
}

/** Hard delete one plan line. */
export async function deletePlanLine(docno, by = "System") {
  const line = await findPlanLine(docno);
  if (!line) return null;

  const status = String(line.status || "").toLowerCase();
  if (status === PROCESS_STATUS.RUNNING) {
    const err = new Error("Cannot delete — status is Running. Hold or complete on Job Card Board first.");
    err.statusCode = 400;
    throw err;
  }

  const deletedStage = Number(line.stage_no);
  const siblings = await runQuery(
    `SELECT stage_no FROM ${T.PLAN} WHERE pjobcardno = $1 AND docno <> $2`,
    [String(line.pjobcardno), Number(docno)]
  );
  const earlier = (siblings || [])
    .map((s) => Number(s.stage_no))
    .filter((n) => Number.isFinite(n) && n < deletedStage);
  const prevStage = earlier.length ? Math.max(...earlier) : null;

  await runQuery(`DELETE FROM ${T.PLAN} WHERE docno = $1`, [Number(docno)]);

  // If we deleted a complete stage line, reopen previous stage as planning.
  if (status === PROCESS_STATUS.COMPLETE && prevStage != null) {
    await runQuery(
      `UPDATE ${T.PLAN}
       SET status = $2, act_end = NULL, updated_by = $4, updated_at = $5
       WHERE pjobcardno = $1 AND stage_no = $3`,
      [String(line.pjobcardno), PROCESS_STATUS.PLANNING, prevStage, userName(by), new Date()]
    );
  }

  return { ...line, reopened_stage: prevStage };
}
