import dbQuery from "../shared/db.js";
import { TASK_TABLES as T } from "../../../config/dbTables.js";

export const TASK_CONFIG_KEYS = {
  NOTIFICATION_TEMPLATES: "notification_templates",
};

const TaskAppConfig = {
  async get(key) {
    const rows = await dbQuery(
      `SELECT config_value FROM ${T.APP_CONFIG} WHERE config_key = ? LIMIT 1`,
      [key]
    );
    return rows[0]?.config_value ?? null;
  },

  async getJson(key, fallback = {}) {
    const raw = await this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  async set(key, value, updated_by = null) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    await dbQuery(
      `INSERT INTO ${T.APP_CONFIG} (config_key, config_value, updated_by, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (config_key) DO UPDATE SET
         config_value = EXCLUDED.config_value,
         updated_by   = EXCLUDED.updated_by,
         updated_at   = CURRENT_TIMESTAMP`,
      [key, text, updated_by]
    );
  },
};

export default TaskAppConfig;
