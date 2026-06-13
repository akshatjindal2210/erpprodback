import TargetDate from "../../models/targetDate.model.js";

export function isAssignedTask(task) {
  return task?.task_type === "assigned";
}

/** Pre-start lock: pending assigned task with no valid target date yet. */
export function isPreStartTargetLock(task, hasValidTarget = null) {
  if (!isAssignedTask(task)) return false;
  if (task.status !== "pending") return false;
  if (hasValidTarget === true) return false;
  if (hasValidTarget === false) return true;
  return true;
}

export async function assignedTaskNeedsTargetDate(task) {
  if (!isAssignedTask(task)) return false;
  if (task.status !== "pending") return false;
  return !(await TargetDate.hasValidCurrent(task.task_id));
}

/** No target date yet — only Assigned By may post in task chat. */
export function isChatLockedForUser(task, hasValidTarget, userId) {
  if (!isAssignedTask(task)) return false;
  if (hasValidTarget === true) return false;
  return Number(task.assigned_by_id) !== Number(userId);
}
