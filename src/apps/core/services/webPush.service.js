import { randomUUID } from "crypto";
import webpush from "web-push";
import config from "../../../config/config.js";
import PushSubscription from "../models/pushSubscription.model.js";
import PushDeliveryLog from "../models/pushDeliveryLog.model.js";
import User from "../models/user.model.js";
import { toUserId } from "../utils/socket.js";
import { formatPushTitle, resolvePushAppBrand } from "../../../config/pushAppBrand.js";

const PUSH_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days — delivers when device comes online

let vapidReady = false;

function initVapid() {
  if (vapidReady) return true;
  const { publicKey, privateKey, subject } = config.web_push ?? {};
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject || "mailto:support@jflbharat.com", publicKey, privateKey);
  vapidReady = true;
  return true;
}

export function isWebPushConfigured() {
  return initVapid();
}

export function getVapidPublicKey() {
  return config.web_push?.publicKey || null;
}

function toWebPushSubscription(row) {
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth,
    },
  };
}

async function sendToRow(row, notification = {}, meta = {}) {
  const tracking_id = randomUUID();
  const app_type = meta.app_type ?? notification.app_type ?? "task";
  const brand = resolvePushAppBrand(app_type);
  const url = notification.url || meta.url || brand.defaultUrl || "/";
  const inbox_id = meta.inbox_id ?? notification.inbox_id ?? null;
  const rawTitle = notification.title || meta.title || brand.label;
  const title = formatPushTitle(app_type, rawTitle);
  const body = notification.body || "";

  const payload = JSON.stringify({
    title,
    body,
    icon: notification.icon || brand.icon,
    badge: notification.badge || brand.badge,
    tag: notification.tag || `push-${app_type}-${tracking_id}`,
    renotify: notification.renotify ?? true,
    url,
    data: {
      url,
      inbox_id: inbox_id != null ? String(inbox_id) : "",
      tracking_id,
      app_type,
      app_label: brand.label,
    },
  });

  try {
    await webpush.sendNotification(toWebPushSubscription(row), payload, {
      TTL: PUSH_TTL_SECONDS,
      urgency: "high",
    });
    await PushSubscription.touchLastUsed(row.subscription_id);

    const log = await PushDeliveryLog.create({
      tracking_id,
      user_id: row.user_id ?? meta.user_id ?? null,
      user_name: row.user_name || meta.user_name || null,
      subscription_id: row.subscription_id,
      device_id: row.device_id,
      device_name: row.device_name || null,
      inbox_id,
      template_key: meta.template_key ?? null,
      channel: meta.channel ?? "pwa_push",
      app_type: meta.app_type ?? "task",
      title,
      body,
      status: "sent",
      sent_at: new Date(),
    });

    return { ok: true, subscription_id: row.subscription_id, tracking_id, log };
  } catch (err) {
    const status = err?.statusCode ?? err?.status;
    if (status === 404 || status === 410) {
      await PushSubscription.removeByEndpoint(row.endpoint);
    }

    const log = await PushDeliveryLog.create({
      tracking_id,
      user_id: row.user_id ?? meta.user_id ?? null,
      user_name: row.user_name || meta.user_name || null,
      subscription_id: row.subscription_id,
      device_id: row.device_id,
      device_name: row.device_name || null,
      inbox_id,
      template_key: meta.template_key ?? null,
      channel: meta.channel ?? "pwa_push",
      app_type: meta.app_type ?? "task",
      title,
      body,
      status: "failed",
      error_detail: err.message,
      sent_at: new Date(),
    });

    return {
      ok: false,
      subscription_id: row.subscription_id,
      tracking_id,
      error: err.message,
      status,
      log,
    };
  }
}

export async function sendWebPushToSubscriptions(rows, notification = {}, meta = {}) {
  if (!initVapid() || !rows?.length) {
    return { ok: false, sent: 0, failed: 0, skipped: !initVapid(), results: [], logs: [] };
  }

  const results = [];
  const logs = [];
  for (const row of rows) {
    const result = await sendToRow(row, notification, meta);
    results.push(result);
    if (result.log) logs.push(result.log);
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  return { ok: sent > 0, sent, failed, results, logs };
}

export async function sendWebPushToUser(userId, notification = {}, meta = {}) {
  const uid = toUserId(userId);
  if (!uid) return { ok: false, sent: 0, failed: 0, error: "Invalid user id" };

  let user_name = meta.user_name ?? null;
  if (!user_name) {
    const user = await User.getById(uid).catch(() => null);
    user_name = user?.name ?? null;
  }

  const rows = await PushSubscription.listByUserId(uid);
  if (!rows.length) {
    return { ok: false, sent: 0, failed: 0, error: "No linked devices for this user", logs: [] };
  }

  return sendWebPushToSubscriptions(rows, notification, { ...meta, user_id: uid, user_name });
}

export async function sendWebPushToDevice(deviceId, notification = {}, meta = {}) {
  if (!deviceId) return { ok: false, sent: 0, failed: 0, error: "device_id required" };
  const rows = await PushSubscription.listByDeviceId(String(deviceId));
  return sendWebPushToSubscriptions(rows, notification, meta);
}

export async function markPushDeliveryReceived(tracking_id) {
  if (!tracking_id) return null;
  return PushDeliveryLog.markReceived(String(tracking_id));
}

export async function markPushDeliveryRead(tracking_id) {
  if (!tracking_id) return null;
  return PushDeliveryLog.markRead(String(tracking_id));
}

export async function markPushDeliveryReadByInbox(inboxId, userId) {
  return PushDeliveryLog.markReadByInbox(inboxId, userId);
}

export async function markPushDeliveryReadAllForUser(userId, options = {}) {
  return PushDeliveryLog.markAllReadForUser(userId, options);
}

export async function getPushDeliveryLogs(query = {}) {
  return PushDeliveryLog.list(query);
}
