export const APP_TYPE = {
  TASK: "task",
  IMS: "ims",
};

export const APP_TYPE_LABELS = {
  task: "Task",
  ims: "IMS",
};

export const TRIGGER_LABELS = {
  task_assigned: "New task",
  target_date_set: "Target date",
  daily_reminder: "Daily summary",
  personal_reminder: "Reminder",
  status_changed: "Status update",
  manual_instant: "Admin message",
};

export const INBOX_SOCKET = {
  NEW_ALERT: "inbox_alert",
  SYNC: "inbox_sync",
};

export function getAppTypeLabel(appType) {
  return APP_TYPE_LABELS[appType] ?? String(appType || "App");
}

export function getTriggerLabel(key) {
  return TRIGGER_LABELS[key] ?? "Alert";
}
