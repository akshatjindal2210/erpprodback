import TaskAppConfig, { TASK_CONFIG_KEYS } from "./taskAppConfig.model.js";

export const SEND_VIA_OPTIONS = ["none", "whatsapp_1", "whatsapp_2", "email"];

export function normalizeTemplate(t) {
  if (!t) return null;

  let send_via = "none";
  if (t.send_via && SEND_VIA_OPTIONS.includes(t.send_via)) {
    send_via = t.send_via;
  } else if (t.whatsapp_enabled) {
    send_via = "whatsapp_1";
  } else if (t.email_enabled) {
    send_via = "email";
  }

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
