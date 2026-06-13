import NotificationTemplate, { SEND_VIA_OPTIONS } from "../models/notificationTemplate.model.js";
import NotificationLog from "../models/notificationLog.model.js";
import { getChannelStatus } from "../services/notification.service.js";

export async function getChannels(req, res) {
  try {
    res.json({ success: true, data: getChannelStatus() });
  } catch (err) {
    console.error("getChannels:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getTemplates(req, res) {
  try {
    const items = await NotificationTemplate.getAll();
    res.json({ success: true, data: items });
  } catch (err) {
    console.error("getTemplates:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function updateTemplate(req, res) {
  try {
    const { key } = req.params;
    const existing = await NotificationTemplate.getByKey(key);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Template not found" });
    }

    const { label, subject, body, is_enabled, pwa_enabled, api_enabled, send_via, trigger_time } = req.body;

    if (send_via !== undefined && !SEND_VIA_OPTIONS.includes(send_via)) {
      return res.status(400).json({ success: false, message: "Invalid send_via channel" });
    }

    await NotificationTemplate.update(key, {
      label,
      subject,
      body,
      is_enabled: is_enabled !== undefined ? !!is_enabled : undefined,
      pwa_enabled: pwa_enabled !== undefined ? !!pwa_enabled : undefined,
      api_enabled: api_enabled !== undefined ? !!api_enabled : undefined,
      send_via: send_via ?? undefined,
      trigger_time: trigger_time ?? null,
    }, req.user.id);

    const updated = await NotificationTemplate.getByKey(key);
    res.json({ success: true, message: "Template updated", data: updated });
  } catch (err) {
    console.error("updateTemplate:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getNotificationLogs(req, res) {
  try {
    const { page = 1, limit = 20, template_key, channel, search } = req.query;
    const result = await NotificationLog.getAll({
      page, limit, template_key, channel, search,
    });
    res.json({
      success: true,
      data: {
        items: result.items,
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / result.limit) || 0,
      },
    });
  } catch (err) {
    console.error("getNotificationLogs:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
