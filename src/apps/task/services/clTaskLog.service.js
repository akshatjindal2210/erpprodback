/**
 * CL Task helpers — audit goes to shared mst_activity_logs via logActivity (same as IMS/Task).
 */
import config from "../../../config/config.js";
import { getISTHour } from "../helpers/clTaskTime.helper.js";
import ActivityLog from "../../core/models/activityLog.model.js";
import { logActivity } from "../../core/utils/logActivity.js";

export const CL_TASK_ENTITY = "cl_task";

export function actorFromReq(req) {
  const u = req?.user || {};
  return {
    id: u.id ?? null,
    name: String(u.name || u.username || u.email || "Unknown").trim() || "Unknown",
  };
}

/** true when frequent-instance spawn hour has been reached today (null/blank = always). */
export function isClCloneAllowedNow() {
  const hour = config.clTask?.cloneAllowedHour;
  if (hour == null || hour === "" || !Number.isFinite(Number(hour))) return true;
  return getISTHour() >= Number(hour);
}

export function getClTaskScheduleMeta() {
  const cloneHour = config.clTask?.cloneAllowedHour;
  const cloneAllowed = isClCloneAllowedNow();
  return {
    clone_allowed_hour: cloneHour,
    clone_allowed_now: cloneAllowed,
    ist_hour: getISTHour(),
    message:
      cloneHour == null
        ? "Frequent tasks spawn at midnight IST"
        : cloneAllowed
          ? `Frequent tasks spawn from ${cloneHour}:00 IST (active now)`
          : `Frequent tasks spawn at ${cloneHour}:00 IST (now ${getISTHour()}:00)`,
  };
}

/** Write to mst_activity_logs (same path as IMS). */
export async function logClTask(req, { action, entity_id = null, record = null, details = {} }) {
  await logActivity(req, {
    action,
    entity: CL_TASK_ENTITY,
    entity_id,
    record,
    details,
    appType: "task",
  });
}

export async function getClTaskLogs(clTaskId, { limit = 100, page = 1 } = {}) {
  const result = await ActivityLog.getAll({
    app_type: "task",
    entity: CL_TASK_ENTITY,
    entity_id: clTaskId,
    page,
    limit: Math.min(Number(limit) || 100, 500),
  });
  return result?.data ?? [];
}

/** Compact snapshot for delete audit (row is hard-deleted after log). */
export function masterDeleteSnapshot(master) {
  if (!master) return {};
  return {
    cl_task_id: master.cl_task_id,
    title: master.title,
    task_type: master.task_type,
    recurrence_type: master.recurrence_type,
    day_offset: master.day_offset,
    person_id: master.person_id,
    person_name: master.person_name,
    department_name: master.department_name,
    verification_user_name: master.verification_user_name,
    approved: master.approved ?? master.is_active,
    approved_by: master.approved_by || master.approved_by_name || master.activated_by_name,
    approved_at: master.approved_at || master.activated_at,
    next_occurrence: master.next_occurrence,
    created_by_name: master.created_by_name,
    created_at: master.created_at,
    updated_by_name: master.updated_by_name,
    updated_at: master.updated_at,
    instance_count: master.instance_count,
  };
}
