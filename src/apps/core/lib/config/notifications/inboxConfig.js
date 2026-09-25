export const APP_TYPE = {
  TASK: "task",
  IMS: "ims",
};

export const APP_TYPE_LABELS = {
  task: "Task",
  ims: "IMS",
  rmstore: "RM Store",
  core: "Admin",
  portal: "Admin",
  hrms: "HRMS",
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
  const k = String(key || "");
  if (k.startsWith("module_")) return "Module notification";
  return TRIGGER_LABELS[k] ?? "Alert";
}

/** Message Logs: recipient when saved to bell/inbox (not a browser device push row). */
export const INBOX_DELIVERY_RECIPIENT_LABEL = "In-app notification";
