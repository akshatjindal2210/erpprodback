import Inbox from "../models/inbox.model.js";
import { emitToUser, getIO, toUserId } from "../../../utils/socket.js";
import { INBOX_SOCKET, getAppTypeLabel, getTriggerLabel } from "../config/inboxConfig.js";

function shortBody(text) {
  return String(text ?? "").split("\n").slice(0, 4).join("\n").trim();
}

export async function saveInboxAlert({
  userId,
  app_type,
  trigger_key,
  title,
  body,
  url = "/",
  task_id = null,
}) {
  const uid = toUserId(userId);
  if (!uid) return { row: null, payload: null };

  // const text = shortBody(body);
  const text = String(body ?? "").trim();
  let row = null;
  try {
    row = await Inbox.create({
      user_id: uid,
      app_type,
      task_id,
      trigger_key,
      title: title || "Notification",
      body: text,
      link_url: url,
    });
  } catch (err) {
    console.warn("[Inbox] save failed:", err.message);
  }

  const payload = {
    inbox_id: row?.inbox_id ?? null,
    app_type,
    app_type_label: getAppTypeLabel(app_type),
    title: title || "Notification",
    body: text,
    url,
    task_id: task_id != null ? String(task_id) : "",
    trigger: trigger_key,
    trigger_label: getTriggerLabel(trigger_key),
  };

  if (getIO()) emitToUser(uid, INBOX_SOCKET.NEW_ALERT, payload);
  return { row, payload };
}

export async function syncUnreadInboxToSocket(userId, { limit = 20 } = {}) {
  const uid = toUserId(userId);
  if (!getIO() || !uid) return;

  try {
    const items = await Inbox.listUnread(uid, { limit });
    if (!items.length) return;
    emitToUser(uid, INBOX_SOCKET.SYNC, { items, count: items.length });
  } catch (err) {
    console.warn("[Inbox] sync failed:", err.message);
  }
}
