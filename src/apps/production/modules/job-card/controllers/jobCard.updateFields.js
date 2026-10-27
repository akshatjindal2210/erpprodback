/**
 * Parse POST /job-card/update body → fields + flags.
 */
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { JOB_CARD_STATUSES, findPrimeProcess } from "../models/jobCard.model.js";
import { diffProcessPlan, statusMapFromPicks, withPlanStatuses } from "../processPlanStatus.js";
import { isValidShift, SHIFTS_PER_DAY } from "../jobCard.config.js";
import { assertMaintainJobcardToolingIfRequired, buildProcessPlan, planKey, remarkMapFromBody } from "./jobCard.controller.helpers.js";

export async function prepareJobCardUpdate(req, existing) {
  const fields = {};
  let hasBusinessChanges = false;
  let softOpsChange = false;
  let planqtyChanged = false;
  const userName = auditUserName(req) || "system";

  const status = req.body.status != null ? String(req.body.status).trim() : "";
  if (status && status !== existing.status) {
    if (!JOB_CARD_STATUSES.includes(status)) {
      return { error: { status: 400, message: `status must be one of: ${JOB_CARD_STATUSES.join(", ")}.` } };
    }
    fields.status = status;
    softOpsChange = true;
  }

  if (req.body.remarks !== undefined) {
    const remarks = req.body.remarks == null ? null : String(req.body.remarks) || null;
    if (remarks !== (existing.remarks ?? null)) {
      fields.remarks = remarks;
      hasBusinessChanges = true;
      softOpsChange = false;
    }
  }

  const jobDate = String(req.body.jobcarddt ?? req.body.job_date ?? req.body.pldt ?? "").trim().slice(0, 10);
  if (jobDate && jobDate !== String(existing.jobcarddt ?? "").slice(0, 10)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(jobDate) || Number.isNaN(Date.parse(jobDate))) {
      return { error: { status: 400, message: "jobcarddt must be a valid date (YYYY-MM-DD)." } };
    }
    fields.jobcarddt = jobDate;
    softOpsChange = true;
  }

  if (req.body.planqty !== undefined && req.body.planqty !== null && req.body.planqty !== "") {
    const pq = Number(req.body.planqty);
    if (!Number.isFinite(pq) || pq < 0) {
      return { error: { status: 400, message: "planqty must be a valid number." } };
    }
    if (pq !== Number(existing.planqty)) {
      fields.planqty = pq;
      planqtyChanged = true;
      hasBusinessChanges = true;
      softOpsChange = false;
    }
  }

  if (req.body.schedule_shift !== undefined) {
    const shift = Number(req.body.schedule_shift);
    if (!isValidShift(shift)) {
      return { error: { status: 400, message: `schedule_shift must be 1–${SHIFTS_PER_DAY}.` } };
    }
    if (shift !== Number(existing.schedule_shift || 1)) {
      fields.schedule_shift = shift;
      softOpsChange = true;
    }
  }

  let processDiffs = [];
  const remarkByProcess = remarkMapFromBody(req.body?.process_remarks);

  if (req.body.process_plan !== undefined) {
    const built = buildProcessPlan(await findPrimeProcess(existing.itemdcode), req.body.process_plan);
    const statusOverrides = statusMapFromPicks(req.body.process_plan);
    const plan = withPlanStatuses(
      built,
      existing.process_plan,
      statusOverrides.size ? statusOverrides : null
    );
    if (planKey(plan) !== planKey(existing.process_plan)) {
      fields.process_plan = plan;
      const noMachines = (p) => planKey((p || []).map((s) => ({ ...s, machines: [] })));
      if (req.body.machine_move === true && noMachines(plan) === noMachines(existing.process_plan)) {
        softOpsChange = true;
      } else {
        if (plan.length && existing.status === "Pending") fields.status = "Planning";
        hasBusinessChanges = true;
        softOpsChange = false;
      }
    } else {
      processDiffs = diffProcessPlan(existing.process_plan, plan);
      if (processDiffs.length) {
        fields.process_plan = plan;
        softOpsChange = true;
      }
    }
    if (fields.process_plan) processDiffs = diffProcessPlan(existing.process_plan, fields.process_plan);
    if (fields.process_plan && Array.isArray(fields.process_plan) && fields.process_plan.length) {
      await assertMaintainJobcardToolingIfRequired(existing);
    }
  }

  const planAfter = fields.process_plan !== undefined ? fields.process_plan : existing.process_plan;
  if (Array.isArray(planAfter) && planAfter.length && existing.approved !== true) {
    fields.approved = true;
    fields.approved_by = userName;
    fields.approved_at = new Date();
  }

  if (Object.keys(fields).length || softOpsChange || hasBusinessChanges) {
    fields.updated_by = userName;
    fields.updated_at = new Date();
  }

  return {
    fields,
    hasBusinessChanges,
    softOpsChange,
    planqtyChanged,
    processDiffs,
    remarkByProcess,
    userName,
  };
}

export function buildUpdateResponseMessage({ softOpsChange, hasBusinessChanges, fields, processDiffs }) {
  if (softOpsChange && !hasBusinessChanges) {
    if (fields.status && !fields.jobcarddt && fields.schedule_shift == null && !processDiffs.length) {
      return `Job card status → ${fields.status}.`;
    }
    if (processDiffs.length && !fields.jobcarddt && fields.schedule_shift == null && !fields.status) {
      return "Process status updated.";
    }
    return "Job card schedule updated.";
  }
  return "Job card updated.";
}
