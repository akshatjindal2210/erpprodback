import { saveInboxAlert, syncUnreadInboxToSocket } from "../../core/services/inboxNotify.service.js";
import { getIO } from "../../../utils/socket.js";
import { APP_TYPE } from "../../core/config/inboxConfig.js";
import { ROUTES } from "../config/taskNotifyConfig.js";

export { INBOX_SOCKET as SOCKET } from "../../core/config/inboxConfig.js";

export function isPwaPushConfigured() {
  return Boolean(getIO());
}

export async function sendTaskPwaPush({ userId, subject, body, message, task_id, template_key }) {
  const trigger = template_key ?? "task_update";
  const title = subject || "Task update";
  // const text = (body || message || "").split("\n").slice(0, 4).join("\n").trim();
  const text = String(body || message || "").trim();
  const url = ROUTES.taskDetail(task_id);

  const { row, payload } = await saveInboxAlert({
    userId,
    app_type: APP_TYPE.TASK,
    trigger_key: trigger,
    title,
    body: text,
    url,
    task_id: task_id ?? null,
  });

  if (!getIO()) {
    return { ok: false, skipped: true, error: "Socket not ready", inbox: row };
  }

  return { ok: true, inbox: row, payload };
}

export const deliverUnreadInboxToSocket = syncUnreadInboxToSocket;
