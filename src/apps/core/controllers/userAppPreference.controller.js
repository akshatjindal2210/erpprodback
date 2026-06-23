import UserAppPreference from "../models/userAppPreference.model.js";
import { USER_PREF_APP_TYPES } from "../../../config/userAppPreferences.js";

const APP_TYPE_SET = new Set(USER_PREF_APP_TYPES);
const PREF_KEY_RE = /^[a-z][a-z0-9_.-]{0,119}$/;

function normalizePrefValue(value) {
  if (value == null) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  return null;
}

export async function getUserAppPreference(req, res) {
  try {
    const app_type = String(req.query.app_type || "").trim().toLowerCase();
    const pref_key = String(req.query.pref_key || "").trim().toLowerCase();

    if (!app_type || !APP_TYPE_SET.has(app_type)) {
      return res.status(400).json({ success: false, message: "Invalid app_type" });
    }
    if (!pref_key || !PREF_KEY_RE.test(pref_key)) {
      return res.status(400).json({ success: false, message: "Invalid pref_key" });
    }

    const row = await UserAppPreference.get(req.user.id, app_type, pref_key);

    res.json({
      success: true,
      data: {
        app_type,
        pref_key,
        pref_value: row?.pref_value ?? {},
        updated_at: row?.updated_at ?? null,
      },
    });
  } catch (err) {
    console.error("getUserAppPreference:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to load preference" });
  }
}

export async function setUserAppPreference(req, res) {
  try {
    const app_type = String(req.body?.app_type || "").trim().toLowerCase();
    const pref_key = String(req.body?.pref_key || "").trim().toLowerCase();
    const pref_value = normalizePrefValue(req.body?.pref_value);

    if (!app_type || !APP_TYPE_SET.has(app_type)) {
      return res.status(400).json({ success: false, message: "Invalid app_type" });
    }
    if (!pref_key || !PREF_KEY_RE.test(pref_key)) {
      return res.status(400).json({ success: false, message: "Invalid pref_key" });
    }
    if (pref_value == null) {
      return res.status(400).json({ success: false, message: "pref_value must be a JSON object" });
    }

    const saved = await UserAppPreference.upsert(req.user.id, app_type, pref_key, pref_value);

    res.json({
      success: true,
      message: "Preference saved",
      data: {
        app_type,
        pref_key,
        pref_value: saved?.pref_value ?? pref_value,
        updated_at: saved?.updated_at ?? null,
      },
    });
  } catch (err) {
    console.error("setUserAppPreference:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to save preference" });
  }
}
