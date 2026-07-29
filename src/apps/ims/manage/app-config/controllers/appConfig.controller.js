import { getAllAppConfig, setAppConfigValue, getAppConfigValue } from "../../../../core/configuration/models/appConfig.model.js";
import { normalizeBoxNoUidPrefix } from "../../../modules/box/utils/uid/boxUid.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import {
  CORE_APP_CONFIG_SECTIONS,
  CORE_APP_CONFIG_DEFINITIONS,
  CORE_APP_CONFIG_SEEDS,
} from "../../../../core/configuration/app.config.js";
import {
  IMS_APP_CONFIG_SECTION,
  IMS_APP_CONFIG_DEFINITIONS,
  IMS_APP_CONFIG_SEEDS,
  IMS_LIST_VIEW_SPAN,
} from "../../../lib/config/app.config.js";
import {
  RMSTORE_APP_CONFIG_SECTION,
  RMSTORE_APP_CONFIG_DEFINITIONS,
  RMSTORE_APP_CONFIG_SEEDS,
} from "../../../../rmstore/lib/config/app.config.js";

const LIST_VIEW_SPAN_MIN = IMS_LIST_VIEW_SPAN.MIN;
const LIST_VIEW_SPAN_MAX = IMS_LIST_VIEW_SPAN.MAX;

/** Defaults when a key is not yet in DB (matches seed + runtime getters). */
const APP_CONFIG_DEFAULTS = {
  ...CORE_APP_CONFIG_SEEDS,
  ...IMS_APP_CONFIG_SEEDS,
  ...RMSTORE_APP_CONFIG_SEEDS,
};

/** UI sections — values stored in `ims_app_config` (per-app files own their sections). */
export const APP_CONFIG_SECTIONS = [
  ...CORE_APP_CONFIG_SECTIONS,
  IMS_APP_CONFIG_SECTION,
  RMSTORE_APP_CONFIG_SECTION,
];

const VALID_SCOPES = new Set(["global", "ims", "task", "rmstore"]);

export function resolveAppConfigScope(raw) {
  const key = String(raw ?? "").trim().toLowerCase();
  if (key === "admin-console" || key === "admin_console" || key === "core" || key === "global") {
    return "global";
  }
  if (VALID_SCOPES.has(key)) return key;
  return "global";
}

/** Admin UI metadata. Values are stored in `ims_app_config`. */
export const APP_CONFIG_DEFINITIONS = [
  ...CORE_APP_CONFIG_DEFINITIONS,
  ...IMS_APP_CONFIG_DEFINITIONS,
  ...RMSTORE_APP_CONFIG_DEFINITIONS,
];

const DEF_BY_KEY = Object.fromEntries(APP_CONFIG_DEFINITIONS.map((d) => [d.key, d]));

function normalizeConfigValue(key, raw) {
  const def = DEF_BY_KEY[key];
  if (!def) return { ok: false, message: "Unknown configuration key" };

  const str = String(raw ?? "").trim();

  if (def.value_type === "boolean") {
    const lower = str.toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) return { ok: true, value: "true" };
    if (["false", "0", "no", "off", ""].includes(lower)) return { ok: true, value: "false" };
    return { ok: false, message: "Use true or false" };
  }

  if (def.value_type === "select") {
    const options = Array.isArray(def.options) ? def.options : [];
    const allowed = options.map((o) => String(o?.value ?? "").trim()).filter(Boolean);
    if (!allowed.length) return { ok: false, message: "No options configured for this setting" };
    if (!allowed.includes(str)) {
      return { ok: false, message: `Choose one of: ${allowed.join(", ")}` };
    }
    return { ok: true, value: str };
  }

  if (def.value_type === "number") {
    const n = parseInt(str, 10);
    if (!Number.isFinite(n)) return { ok: false, message: "Enter a valid number" };
    const min = def.min ?? LIST_VIEW_SPAN_MIN;
    const max = def.max ?? LIST_VIEW_SPAN_MAX;
    if (n < min || n > max) {
      return { ok: false, message: `Value must be between ${min} and ${max}` };
    }
    return { ok: true, value: String(n) };
  }

  if (def.value_type === "box_no_uid_prefix") {
    const n = normalizeBoxNoUidPrefix(str);
    if (!n) {
      return { ok: false, message: "Use 1-8 letters or digits (e.g. 2026 or 26)" };
    }
    return { ok: true, value: n };
  }

  if (def.value_type === "url") {
    if (!str) return { ok: true, value: "" };
    if (!/^https?:\/\//i.test(str)) {
      return { ok: false, message: "URL must start with http:// or https://" };
    }
    try {
      new URL(str.replace(/[?&]+$/, "").replace(/\/+$/, ""));
    } catch {
      return { ok: false, message: "Invalid URL" };
    }
    return { ok: true, value: str };
  }

  return { ok: true, value: str };
}

function definitionsForScope(scope) {
  return APP_CONFIG_DEFINITIONS.filter((def) => def.scope === scope);
}

function sectionsForScope(scope) {
  return APP_CONFIG_SECTIONS.filter((section) => section.scope === scope);
}

function mergeDefinitionsWithRows(rows = [], scope = "global") {
  const byKey = Object.fromEntries(rows.map((r) => [r.config_key, r]));
  return definitionsForScope(scope).map((def) => {
    const row = byKey[def.key];
    const fromDb = row?.config_value;
    const hasDbValue = fromDb != null && String(fromDb).trim() !== "";
    return {
      ...def,
      config_value: hasDbValue ? fromDb : (APP_CONFIG_DEFAULTS[def.key] ?? ""),
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    };
  });
}

/** Super admin: list keys for a scope (global admin console or per-app). */
export const getAppConfigList = async (req, res) => {
  try {
    const rawApp = req.body?.app ?? req.body?.scope;
    const scope = resolveAppConfigScope(rawApp);
    const rows = await getAllAppConfig();

    let sections = sectionsForScope(scope);
    let data = mergeDefinitionsWithRows(rows, scope);

    // If the requested 'app' is actually a section ID, filter by it
    const sectionId = String(rawApp ?? "").trim().toLowerCase();
    const isSection = APP_CONFIG_SECTIONS.some((s) => s.id === sectionId);
    if (isSection) {
      sections = sections.filter((s) => s.id === sectionId);
      data = data.filter((d) => d.section === sectionId);
    }

    res.json({
      success: true,
      scope,
      sections,
      data,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** Super admin: update one key. */
export const updateAppConfig = async (req, res) => {
  try {
    const config_key = String(req.body?.config_key ?? "").trim();
    if (!config_key || !DEF_BY_KEY[config_key]) {
      return res.status(400).json({ success: false, message: "Invalid configuration key" });
    }

    const normalized = normalizeConfigValue(config_key, req.body?.config_value);
    if (!normalized.ok) {
      return res.status(400).json({ success: false, message: normalized.message });
    }

    await setAppConfigValue(config_key, normalized.value, { updated_by: auditUserName(req) });

    const fresh = await getAppConfigValue(config_key);
    res.json({
      success: true,
      message: "Configuration saved",
      data: {
        ...DEF_BY_KEY[config_key],
        config_key,
        config_value: fresh ?? normalized.value,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
