import dbQuery from "../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T, ENGINEERING_TABLES as E } from "../../../../../config/db/dbTables.js";
import { machineStatusRows, parseProcessPlan, PROCESS_STATUS_VALUES } from "../../jc/processPlanStatus.js";
import { calcJobCardProductionTime, shiftsForMachine } from "../../jc/jobCardProductionTime.js";
import { findPrimeProcess } from "../../jc/models/jobCard.model.js";
import { SHIFTS_PER_DAY } from "../../jc/jobCard.config.js";

const JOIN = `
  LEFT JOIN ${E.PROCESS_MASTER} pr ON pr.proccode = p.proccode AND COALESCE(pr.is_deleted, false) = false
  LEFT JOIN ${E.MACHINE_MASTER} m ON m.maccode = p.maccode AND COALESCE(m.is_deleted, false) = false`;

const LIST = `SELECT p.docno, p.pjobcardno, p.proccode, p.maccode, p.stage_no, p.status,
  p.plan_start, p.plan_end, p.actual_start, p.actual_end,
  pr.procname AS process_name, m.macname AS machine_name,
  j.docno AS job_card_docno, j.itemdcode, j.planqty AS qty, j.schedule_shift AS plan_shift,
  j.status AS card_status, j.process_plan
  FROM ${T.PLAN} p
  INNER JOIN ${T.JC} j ON j.pjobcardno = p.pjobcardno AND j.approved = true AND COALESCE(j.is_deleted, false) = false
  ${JOIN}`;

async function rows(sql, params, client) {
  if (client) return (await client.query(sql, params)).rows;
  return dbQuery(sql, params);
}

function planEnd(start, shift, shifts) {
  if (!start || !shifts) return start;
  const off = Math.floor((Number(shift || 1) - 1 + Number(shifts) - 1) / Math.max(1, SHIFTS_PER_DAY));
  const d = new Date(`${start}T12:00:00`);
  d.setDate(d.getDate() + off);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {number|null} jcDocno — when set, lines for one JC (Maintain Job Card history).
 * @param {{ from_date?: string, to_date?: string }} [filters] — plan_start range (Planning Table IMS style).
 */
export async function listPlanRows(jcDocno, filters = {}) {
  const where = [];
  const params = [];

  const id = Number(jcDocno);
  if (id) {
    params.push(id);
    where.push(`j.docno = $${params.length}`);
  }

  const from = String(filters?.from_date || "").slice(0, 10);
  const to = String(filters?.to_date || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    params.push(from);
    where.push(`p.plan_start IS NOT NULL AND p.plan_start::date >= $${params.length}::date`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    params.push(to);
    where.push(`p.plan_start IS NOT NULL AND p.plan_start::date <= $${params.length}::date`);
  }

  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  return rows(
    `${LIST}${clause} ORDER BY p.plan_start DESC NULLS LAST, p.pjobcardno DESC, p.stage_no, p.proccode`,
    params
  );
}

export async function syncPlanFromJobCard(card, client = null) {
  const pjobcardno = String(card?.pjobcardno || "").trim();
  if (!pjobcardno) return;

  const plan = parseProcessPlan(card.process_plan);
  // Unapprove or empty process_plan → drop board/calendar lines (list only shows approved JC).
  if (!card.approved || !plan.length) {
    await rows(`DELETE FROM ${T.PLAN} WHERE pjobcardno = $1`, [pjobcardno], client);
    return;
  }

  const planStart = String(card.jobcarddt || "").slice(0, 10) || null;
  const shift = Number(card.schedule_shift) || 1;
  let est = null;
  try {
    const stages = await findPrimeProcess(Number(card.itemdcode));
    if (stages?.length) {
      est = calcJobCardProductionTime({ qty: Number(card.planqty) || 0, stages, process_plan: plan });
    }
  } catch (err) {
    console.warn("[syncPlanFromJobCard] plan_end estimate failed:", err?.message || err);
  }
  const now = new Date();
  const keys = new Set();

  // One SELECT for existing lines — avoid N+1 per machine row.
  const existing = await rows(
    `SELECT docno, proccode, maccode, actual_start, actual_end FROM ${T.PLAN} WHERE pjobcardno = $1`,
    [pjobcardno],
    client
  );
  const byKey = new Map(existing.map((ex) => [`${ex.proccode}:${Number(ex.maccode) || 0}`, ex]));

  for (const line of machineStatusRows(plan)) {
    const proccode = Number(line.process_id);
    const maccode = Number(line.machine_id) || null;
    const key = `${proccode}:${maccode || 0}`;
    keys.add(key);
    const status = String(line.status || "pending").toLowerCase();
    const stageNo = line.stage_no != null ? Number(line.stage_no) : null;
    const prev = byKey.get(key);
    // plan_end from this machine's shifts (PACK ≠ whole JC total)
    const macShifts = shiftsForMachine(est, maccode, stageNo) ?? est?.shifts;
    const planEndDate = planEnd(planStart, shift, macShifts);

    let actualStart = prev?.actual_start ?? null;
    let actualEnd = prev?.actual_end ?? null;
    if (status === "running" && !actualStart) actualStart = now;
    if (status === "complete" && !actualEnd) actualEnd = now;

    if (prev) {
      await rows(
        `UPDATE ${T.PLAN} SET stage_no=$2, status=$3, plan_start=$4, plan_end=$5,
         actual_start=$6, actual_end=$7 WHERE docno=$1`,
        [prev.docno, stageNo, status, planStart, planEndDate, actualStart, actualEnd],
        client
      );
    } else {
      await rows(
        `INSERT INTO ${T.PLAN}
         (pjobcardno, proccode, maccode, stage_no, status, plan_start, plan_end, actual_start, actual_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [pjobcardno, proccode, maccode, stageNo, status, planStart, planEndDate, actualStart, actualEnd],
        client
      );
    }
  }

  for (const ex of existing) {
    const k = `${ex.proccode}:${Number(ex.maccode) || 0}`;
    if (!keys.has(k)) await rows(`DELETE FROM ${T.PLAN} WHERE docno = $1`, [ex.docno], client);
  }
}

export async function findPlanLine(docno) {
  const id = Number(docno);
  if (!id) return null;
  const [row] = await rows(`${LIST} WHERE p.docno = $1`, [id]);
  return row || null;
}

function toDateOrNull(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function toStatusOrNull(v) {
  if (v == null || v === "") return null;
  const st = String(v).toLowerCase().trim();
  return PROCESS_STATUS_VALUES.includes(st) ? st : null;
}

/**
 * Planning UI only — UPDATE prod_plan.
 * Does NOT write prod_jc (process/machine/stage live on JC at job-card save time).
 */
export async function updatePlanLine(docno, patch = {}) {
  const line = await findPlanLine(docno);
  if (!line) return null;

  const plan_start = patch.plan_start !== undefined ? toDateOrNull(patch.plan_start) : line.plan_start;
  const plan_end = patch.plan_end !== undefined ? toDateOrNull(patch.plan_end) : line.plan_end;
  const status =
    patch.status !== undefined
      ? toStatusOrNull(patch.status)
      : String(line.status || "pending").toLowerCase();
  if (patch.status !== undefined && !status) {
    const err = new Error("Invalid status.");
    err.statusCode = 400;
    throw err;
  }

  let maccode = line.maccode;
  if (patch.maccode !== undefined) {
    if (patch.maccode === null || patch.maccode === "") maccode = null;
    else {
      const m = Number(patch.maccode);
      maccode = Number.isFinite(m) && m > 0 ? m : line.maccode;
    }
  }

  const now = new Date();
  let actual_start = line.actual_start;
  let actual_end = line.actual_end;
  // Start → stamp actual_start once; Complete → stamp actual_end once
  if (status === "running" && !actual_start) actual_start = now;
  if (status === "complete" && !actual_end) actual_end = now;

  const [updated] = await rows(
    `UPDATE ${T.PLAN}
     SET plan_start = $2, plan_end = $3, status = $4, actual_start = $5, actual_end = $6, maccode = $7
     WHERE docno = $1
     RETURNING docno, pjobcardno, proccode, maccode, stage_no, status, plan_start, plan_end, actual_start, actual_end`,
    [Number(docno), plan_start, plan_end, status, actual_start, actual_end, maccode]
  );

  return updated || null;
}

/** Planning Table → Delete one prod_plan line (board/calendar/table). */
export async function deletePlanLine(docno) {
  const line = await findPlanLine(docno);
  if (!line) return null;
  await rows(`DELETE FROM ${T.PLAN} WHERE docno = $1`, [Number(docno)]);
  return line;
}
