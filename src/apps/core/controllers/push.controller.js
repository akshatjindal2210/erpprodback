import PushSubscription from "../models/pushSubscription.model.js";
import config from "../../../config/config.js";
import { getVapidPublicKey, getPushDeliveryLogs, isWebPushConfigured, markPushDeliveryRead, markPushDeliveryReceived, sendWebPushToDevice, sendWebPushToUser } from "../services/webPush.service.js";

function parseDeliveryMeta(body = {}) {
  const client_ip = String(body?.client_ip ?? "").trim() || null;
  if (typeof body?.on_company_network === "boolean") {
    return { client_ip, on_company_network: body.on_company_network };
  }
  if (body?.on_internal_domain === true) {
    return { client_ip, on_company_network: true };
  }
  if (body?.on_internal_domain === false) {
    return { client_ip, on_company_network: false };
  }
  return { client_ip, on_company_network: null };
}

function parseSubscription(body = {}) {
  const sub = body.subscription ?? body;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return { error: "Invalid push subscription (endpoint + keys required)" };
  }
  return { endpoint, p256dh, auth };
}

export async function getPushPublicKey(req, res) {
  try {
    const publicKey = getVapidPublicKey();
    if (!publicKey) {
      return res.status(503).json({ success: false, message: "Web push is not configured on the server" });
    }
    res.json({ success: true, data: { publicKey, configured: isWebPushConfigured() } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function savePushSubscription(req, res) {
  try {
    const device_id = String(req.body?.device_id ?? "").trim();
    if (!device_id || device_id.length > 64) {
      return res.status(400).json({ success: false, message: "Valid device_id is required" });
    }

    const parsed = parseSubscription(req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, message: parsed.error });
    }

    const user_id = req.user?.id ?? null;
    const user_name = req.user?.name ?? null;
    const device_name = String(req.body?.device_name ?? "").trim() || null;

    const row = await PushSubscription.upsert({
      device_id,
      user_id,
      user_name,
      device_name,
      endpoint: parsed.endpoint,
      p256dh: parsed.p256dh,
      auth: parsed.auth,
      user_agent: req.headers["user-agent"] ?? null,
    });

    res.json({
      success: true,
      message: "Push subscription saved",
      data: {
        subscription_id: row?.subscription_id,
        device_id,
        device_name: row?.device_name,
        linked_user_id: row?.user_id ?? null,
        linked_user_name: row?.user_name ?? null,
      },
    });
  } catch (err) {
    console.error("savePushSubscription:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function linkPushSubscription(req, res) {
  try {
    const device_id = String(req.body?.device_id ?? "").trim();
    if (!device_id) {
      return res.status(400).json({ success: false, message: "device_id is required" });
    }

    const device_name = String(req.body?.device_name ?? "").trim() || null;
    const { count, rows } = await PushSubscription.linkDeviceToUser(device_id, req.user.id, {
      user_name: req.user.name,
      device_name,
    });

    if (req.body?.subscription) {
      const parsed = parseSubscription(req.body);
      if (!parsed.error) {
        await PushSubscription.upsert({
          device_id,
          user_id: req.user.id,
          user_name: req.user.name,
          device_name,
          endpoint: parsed.endpoint,
          p256dh: parsed.p256dh,
          auth: parsed.auth,
          user_agent: req.headers["user-agent"] ?? null,
        });
      }
    }

    res.json({
      success: true,
      message: count ? "Device linked to your account" : "No prior subscription for this device",
      data: { linked: count, user_name: req.user.name, devices: rows ?? [] },
    });
  } catch (err) {
    console.error("linkPushSubscription:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

/** Optional unlink — device stays linked on logout; re-linked when another user logs in on same device. */
export async function unlinkPushSubscription(req, res) {
  try {
    const device_id = String(req.body?.device_id ?? "").trim();
    if (!device_id) {
      return res.status(400).json({ success: false, message: "device_id is required" });
    }

    const normalizedRole = String(req.user?.role ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    const force = normalizedRole === "super_admin";
    const { count } = await PushSubscription.unlinkDevice(device_id, {
      user_id: req.user?.id,
      force,
    });
    res.json({
      success: true,
      message: count ? "Device unlinked from push notifications" : "No subscription found for this device",
      data: { unlinked: count },
    });
  } catch (err) {
    console.error("unlinkPushSubscription:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function unsubscribePush(req, res) {
  try {
    const endpoint = req.body?.endpoint ?? req.body?.subscription?.endpoint;
    const device_id = String(req.body?.device_id ?? "").trim();

    if (endpoint) {
      await PushSubscription.removeByEndpoint(endpoint);
    } else if (device_id) {
      await PushSubscription.removeByDevice(device_id);
    } else {
      return res.status(400).json({ success: false, message: "endpoint or device_id required" });
    }

    res.json({ success: true, message: "Push subscription removed" });
  } catch (err) {
    console.error("unsubscribePush:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function reportPushReceived(req, res) {
  try {
    const tracking_id = String(req.body?.tracking_id ?? "").trim();
    if (!tracking_id) {
      return res.status(400).json({ success: false, message: "tracking_id is required" });
    }

    const row = await markPushDeliveryReceived(tracking_id, parseDeliveryMeta(req.body));
    if (!row) {
      return res.status(404).json({ success: false, message: "Delivery log not found or already updated" });
    }

    res.json({ success: true, message: "Marked as received", data: row });
  } catch (err) {
    console.error("reportPushReceived:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function reportPushRead(req, res) {
  try {
    const tracking_id = String(req.body?.tracking_id ?? "").trim();
    if (!tracking_id) {
      return res.status(400).json({ success: false, message: "tracking_id is required" });
    }

    if (req.body?.company_network_verified !== true) {
      return res.status(403).json({
        success: false,
        message: "Read is recorded only when the user opens the app from an authorized portal domain",
      });
    }

    const row = await markPushDeliveryRead(tracking_id, parseDeliveryMeta(req.body));
    if (!row) {
      return res.status(404).json({ success: false, message: "Delivery log not found" });
    }

    res.json({ success: true, message: "Marked as read", data: row });
  } catch (err) {
    console.error("reportPushRead:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function sendPushNotification(req, res) {
  try {
    const { user_id, device_id, title, body, url, tag, data, inbox_id, app_type } = req.body ?? {};

    if (!user_id && !device_id) {
      return res.status(400).json({ success: false, message: "user_id or device_id is required" });
    }
    if (!title && !body) {
      return res.status(400).json({ success: false, message: "title or body is required" });
    }

    const notification = { title, body, url, tag, data, app_type };
    const meta = {
      inbox_id: inbox_id ?? data?.inbox_id ?? null,
      app_type: app_type ?? data?.app_type ?? "task",
    };
    const result = user_id
      ? await sendWebPushToUser(user_id, notification, meta)
      : await sendWebPushToDevice(device_id, notification, meta);

    if (result.skipped) {
      return res.status(503).json({ success: false, message: "Web push is not configured", data: result });
    }

    res.json({
      success: result.ok,
      message: result.ok
        ? `Sent to ${result.sent} device(s)`
        : "No linked devices or delivery failed",
      data: result,
    });
  } catch (err) {
    console.error("sendPushNotification:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getPushLogs(req, res) {
  try {
    const { page, limit, user_id, status, search } = req.query ?? {};
    const data = await getPushDeliveryLogs({ page, limit, user_id, status, search });
    res.json({
      success: true,
      data: {
        items: data.items,
        page: data.page,
        limit: data.limit,
        total: data.total,
        totalPages: Math.ceil(data.total / data.limit) || 0,
      },
    });
  } catch (err) {
    console.error("getPushLogs:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
