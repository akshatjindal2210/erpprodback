import { saveInboxAlert, syncUnreadInboxToSocket } from "../../../../core/notifications/inbox/inboxNotify.service.js";
import { getIO } from "../../../../core/lib/utils/realtime/socket.js";
import { APP_TYPE } from "../../../../core/lib/config/notifications/inboxConfig.js";
import { ROUTES } from "../../../lib/config/notifications/taskNotifyConfig.js";
import { isWebPushConfigured, sendWebPushToUser } from "../../../../core/notifications/push/webPush.service.js";

export { INBOX_SOCKET as SOCKET } from "../../../../core/lib/config/notifications/inboxConfig.js";

export function isPwaPushConfigured() {
  return Boolean(getIO()) || isWebPushConfigured();
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

  const result = { ok: false, inbox: row, payload, channels: [] };

  if (getIO()) {
    result.ok = true;
    result.channels.push("socket");
  }

  if (isWebPushConfigured()) {
    const tag = row?.inbox_id ? `inbox-${row.inbox_id}` : `task-${task_id || trigger}`;
    const push = await sendWebPushToUser(
      userId,
      { title, body: text, url, tag, data: { url, inbox_id: row?.inbox_id ?? "" } },
      { inbox_id: row?.inbox_id ?? null, user_id: userId, template_key: trigger, channel: "pwa_push", app_type: "task" }
    );
    if (push.ok) {
      result.ok = true;
      result.channels.push("web_push");
      result.web_push = push;
    } else if (!result.ok) {
      return {
        ok: false,
        skipped: false,
        error: push.error || "Web push delivery failed",
        inbox: row,
        push,
      };
    }
  }

  if (!result.ok) {
    return { ok: false, skipped: true, error: "Socket not ready and web push not configured", inbox: row };
  }

  return result;
}

export const deliverUnreadInboxToSocket = syncUnreadInboxToSocket;
