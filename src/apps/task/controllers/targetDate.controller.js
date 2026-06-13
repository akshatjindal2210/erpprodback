import Task from "../models/task.model.js";
import TargetDate from "../models/targetDate.model.js";
import { sendTaskNotification } from "../services/notification.service.js";
import { isAssignedTask } from "../shared/utils/targetDateHelper.js";

const log = (task_id, user_id, performed_by, action, action_detail = null, assignment_id = null) =>
  Task.addLog(task_id, user_id, performed_by, action, action_detail, assignment_id);

/** Only Assigned To person (first_assigned_to) may set target date — no role override (incl. super_admin). */
function canSetTargetDate(reqUser, task) {
  const role = (reqUser.type ?? reqUser.role ?? "").toLowerCase();
  if (role === "super_admin") return false;
  return Number(reqUser.id) === Number(task.first_assigned_to_id ?? task.first_assigned_to);
}

export function canUserSetTargetDate(userId, task) {
  return canSetTargetDate({ id: userId }, task);
}

function formatTargetForNotify(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return String(dt);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

export async function setTargetDate(req, res) {
  try {
    const { id } = req.params;
    const { target_at } = req.body;
    const user_id = req.user.id;
    const user_name = req.user.name ?? "Someone";

    if (!target_at?.trim()) {
      return res.status(400).json({ success: false, message: "target_at is required" });
    }

    const task = await Task.getById(id);
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });
    if (!isAssignedTask(task)) {
      return res.status(400).json({ success: false, message: "Target date applies only to assigned tasks" });
    }
    if (task.status === "completed") {
      return res.status(400).json({ success: false, message: "Task is already completed" });
    }
    if (!canSetTargetDate(req.user, task)) {
      return res.status(403).json({
        success: false,
        message: "Only Assigned To person can set target date.",
      });
    }

    const targetDate = new Date(target_at);
    if (Number.isNaN(targetDate.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid target_at datetime" });
    }
    if (targetDate <= new Date()) {
      return res.status(400).json({ success: false, message: "Target date must be in the future" });
    }

    await TargetDate.set(id, targetDate, user_id, user_name);

    if (task.status === "pending") {
      await Task.updateStatus(id, "in_progress");
      await log(id, user_id, user_name, "status_changed", "Status changed to In Progress (target date set)", null);
    }

    const detail = `Target date set: ${formatTargetForNotify(targetDate)}`;
    await log(id, user_id, user_name, "target_date_set", detail, null);

    const assignerId = task.assigned_by_id ?? task.assigned_by;
    if (assignerId && Number(assignerId) !== Number(user_id)) {
      void sendTaskNotification("target_date_set", assignerId, {
        task_title: task.title,
        task_id: String(task.task_id),
        target_date: formatTargetForNotify(targetDate),
        assigned_by: task.assigned_by_name ?? "Assigned By",
        assigned_to_name: user_name,
        status: "In Progress",
        due_date: task.due_date ?? "-",
      }, Number(id));
    }

    const [history, current] = await Promise.all([
      TargetDate.getHistory(id),
      TargetDate.getCurrent(id),
    ]);

    res.json({
      success: true,
      message: "Target date set successfully",
      data: { current, history },
    });
  } catch (err) {
    console.error("setTargetDate:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getTargetDates(req, res) {
  try {
    const { id } = req.params;
    const task = await Task.getById(id);
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });

    const [history, current] = await Promise.all([
      TargetDate.getHistory(id),
      TargetDate.getCurrent(id),
    ]);

    const has_valid_target = await TargetDate.hasValidCurrent(id);

    res.json({
      success: true,
      data: { current, history, has_valid_target },
    });
  } catch (err) {
    console.error("getTargetDates:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
