import dbQuery from "../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T, ENGINEERING_TABLES as E } from "../../../../../config/db/dbTables.js";
import { machineStatusRows, parseProcessPlan } from "../../jc/processPlanStatus.js";
import { calcJobCardProductionTime } from "../../jc/jobCardProductionTime.js";
import { findPrimeProcess } from "../../jc/models/jobCard.model.js";
import { SHIFTS_PER_DAY } from "../../jc/jobCard.config.js";

const JOIN = `
  LEFT JOIN ${E.PROCESS_MASTER} pr ON pr.proccode = p.proccode AND COALESCE(pr.is_deleted, false) = false
  LEFT JOIN ${E.MACHINE_MASTER} m ON m.maccode = p.maccode AND COALESCE(m.is_deleted, false) = false`;

const LIST = `SELECT p.docno, p.pjobcardno, p.proccode, p.maccode, p.stage_no, p.status,
  p.plan_start, p.plan_end, p.actual_start, p.actual_end,
  pr.procname AS process_name, m.macname AS machine_name,
  j.docno AS job_card_docno, j.itemdcode, j.planqty AS qty, j.schedule_shift AS plan_shift, j.status AS card_status
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

export async function listPlanRows(jcDocno) {
  const id = Number(jcDocno);
  if (id) {
    return rows(`${LIST} WHERE j.docno = $1 ORDER BY p.plan_start NULLS LAST, p.stage_no, p.proccode`, [id]);
  }
  return rows(`${LIST} ORDER BY p.plan_start NULLS LAST, p.pjobcardno, p.stage_no, p.proccode`);
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
  let shifts = null;
  try {
    const stages = await findPrimeProcess(Number(card.itemdcode));
    if (stages?.length) {
      shifts = calcJobCardProductionTime({ qty: Number(card.planqty) || 0, stages, process_plan: plan })?.shifts;
    }
  } catch (err) {
    console.warn("[syncPlanFromJobCard] plan_end estimate failed:", err?.message || err);
  }
  const planEndDate = planEnd(planStart, shift, shifts);
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
