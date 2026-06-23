import dbQuery from "../../../config/db.js";
import { MST_TABLES as T } from "../../../config/dbTables.js";

const TABLE = T.USER_APP_PREFERENCES;

function parsePrefValue(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const UserAppPreference = {
  async get(userId, appType, prefKey) {
    const [row] = await dbQuery(
      `SELECT pref_value, updated_at
       FROM ${TABLE}
       WHERE user_id = $1 AND app_type = $2 AND pref_key = $3
       LIMIT 1`,
      [Number(userId), String(appType), String(prefKey)]
    );
    if (!row) return null;
    return {
      pref_value: parsePrefValue(row.pref_value),
      updated_at: row.updated_at,
    };
  },

  async upsert(userId, appType, prefKey, prefValue) {
    const valueJson = JSON.stringify(prefValue ?? {});
    await dbQuery(
      `INSERT INTO ${TABLE} (user_id, app_type, pref_key, pref_value, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, app_type, pref_key) DO UPDATE SET
         pref_value = EXCLUDED.pref_value,
         updated_at = CURRENT_TIMESTAMP`,
      [Number(userId), String(appType), String(prefKey), valueJson]
    );
    return this.get(userId, appType, prefKey);
  },
};

export default UserAppPreference;
