import { DASHBOARD_STAT_KEYS } from "./dashboardStatKeys.js";

export const TASK_NOTIFY_VARIABLE_KEYS = [
  "task_id",
  "task_title",
  "task_description",
  "user_name",
  "status",
  "priority",
  "category",
  "assigned_by",
  "assigned_to_name",
  "created_by_name",
  "current_holder_name",
  "due_date",
  "reminder_date",
  "target_date",
  "reminder_at",
  "created_at",
  "completed_at",
  "task_type",
  ...DASHBOARD_STAT_KEYS,
];

export function formatNotifyStatus(status) {
  if (!status) return "";
  return String(status)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function buildNotifyVarsFromTask(task, overrides = {}) {
  if (!task) return { ...overrides };

  const merged = {
    task_id: String(task.task_id),
    task_title: task.title ?? "",
    task_description: task.description ?? "",
    priority: task.priority ?? "",
    category: task.category_name ?? "",
    assigned_by: task.assigned_by_name ?? "",
    assigned_to_name: task.first_assigned_to_name ?? "",
    created_by_name: task.created_by_name ?? "",
    current_holder_name: task.current_holder_name ?? "",
    due_date: task.due_date ?? "-",
    reminder_date: task.reminder_date ?? "",
    created_at: task.created_at ?? "",
    completed_at: task.completed_at ?? "",
    task_type: task.task_type ?? "",
    ...overrides,
  };

  merged.task_id = String(overrides.task_id ?? task.task_id);
  merged.task_title = overrides.task_title ?? task.title ?? "";

  merged.status = formatNotifyStatus(overrides.status ?? task.status);

  return merged;
}

export function pickNotifyVarsForFilter(vars = {}) {
  const out = {};
  for (const key of TASK_NOTIFY_VARIABLE_KEYS) {
    const val = vars[key];
    if (val != null && String(val).trim() !== "") {
      out[key] = val;
    }
  }
  return out;
}
