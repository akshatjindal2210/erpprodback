import TaskAppConfig, { TASK_CONFIG_KEYS } from "./taskAppConfig.model.js";

export const SEND_VIA_OPTIONS = ["none", "free", "paid"];

export function coerceSendVia(raw, legacy = {}) {
  const v = String(raw ?? "");
  if (SEND_VIA_OPTIONS.includes(v)) return v;
  if (v === "whatsapp_2") return "paid";
  if (v === "whatsapp_1") return "free";
  if (v === "email") return "none";
  if (legacy.whatsapp_enabled) return "free";
  return "none";
}

export function normalizeTemplate(t) {
  if (!t) return null;

  const send_via = coerceSendVia(t.send_via, t);

  const is_enabled = !!t.is_enabled;
  return {
    ...t,
    send_via,
    pwa_enabled: t.pwa_enabled !== undefined ? !!t.pwa_enabled : is_enabled,
    api_enabled: t.api_enabled !== undefined ? !!t.api_enabled : is_enabled && send_via !== "none",
  };
}

const NotificationTemplate = {
  async getAll() {
    const map = await TaskAppConfig.getJson(TASK_CONFIG_KEYS.NOTIFICATION_TEMPLATES, {});
    return Object.values(map)
      .map(normalizeTemplate)
      .sort((a, b) => String(a.template_key).localeCompare(String(b.template_key)));
  },

  async getByKey(key) {
    const map = await TaskAppConfig.getJson(TASK_CONFIG_KEYS.NOTIFICATION_TEMPLATES, {});
    return normalizeTemplate(map[key] ?? null);
  },

  async update(key, data, updated_by) {
    const map = await TaskAppConfig.getJson(TASK_CONFIG_KEYS.NOTIFICATION_TEMPLATES, {});
    const prev = normalizeTemplate(map[key] ?? { template_key: key });
    const next = { ...prev, template_key: key, updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) next[k] = v;
    }
    if (next.send_via && !SEND_VIA_OPTIONS.includes(next.send_via)) {
      next.send_via = "none";
    }
    delete next.email_enabled;
    delete next.whatsapp_enabled;
    map[key] = next;
    await TaskAppConfig.set(TASK_CONFIG_KEYS.NOTIFICATION_TEMPLATES, map, updated_by);
    return next;
  },
};

export default NotificationTemplate;
