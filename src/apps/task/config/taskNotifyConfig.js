export {
  APP_TYPE,
  APP_TYPE_LABELS,
  TRIGGER_LABELS,
  getAppTypeLabel,
  getTriggerLabel,
  INBOX_SOCKET,
} from "../../core/config/inboxConfig.js";

export const SOCKET = {
  NEW_ALERT: "inbox_alert",
  INBOX_SYNC: "inbox_sync",
};

export const ROUTES = {
  TASK_LIST: "/task/dashboard/tasks",
  taskDetail: (taskId) => (taskId ? `/task/dashboard/tasks/${taskId}` : "/task/dashboard/tasks"),
};
