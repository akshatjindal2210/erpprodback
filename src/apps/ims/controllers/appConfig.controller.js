import { getAllAppConfig, setAppConfigValue, getAppConfigValue, APP_CONFIG_KEYS } from "../../core/models/appConfig.model.js";
import { normalizeBoxNoUidPrefix } from "../../../global/boxUid.js";

const LIST_VIEW_SPAN_MIN = 1;
const LIST_VIEW_SPAN_MAX = 3650;

/** UI sections — values stored in `ims_app_config` (global keys apply org-wide). */
export const APP_CONFIG_SECTIONS = [
  {
    id: "company",
    scope: "global",
    title: "Company details",
    description: "Core organisation profile used across apps (e.g. sticker branding).",
  },
  {
    id: "application",
    scope: "ims",
    title: "Application settings",
    description: "IMS behaviour for all users (not server env / .env).",
  },
];

const VALID_SCOPES = new Set(["global", "ims", "task"]);

export function resolveAppConfigScope(raw) {
  const key = String(raw ?? "").trim().toLowerCase();
  if (key === "admin-console" || key === "admin_console" || key === "core" || key === "global") {
    return "global";
  }
  if (VALID_SCOPES.has(key)) return key;
  return "global";
}

/** Admin UI metadata (English). Values are stored in `ims_app_config`. */
export const APP_CONFIG_DEFINITIONS = [
  {
    key: APP_CONFIG_KEYS.COMPANY_NAME,
    scope: "global",
    section: "company",
    label: "Company name",
    value_type: "text",
    description: "Legal / display name on stickers.",
  },
  {
    key: APP_CONFIG_KEYS.COMPANY_ADDRESS,
    scope: "global",
    section: "company",
    label: "Street address",
    value_type: "text",
    description: "Plot / street line printed on stickers.",
  },
  {
    key: APP_CONFIG_KEYS.COMPANY_STATE,
    scope: "global",
    section: "company",
    label: "State",
    value_type: "text",
    description: "State or region (shown with pincode on stickers).",
  },
  {
    key: APP_CONFIG_KEYS.COMPANY_PINCODE,
    scope: "global",
    section: "company",
    label: "Pincode",
    value_type: "text",
    description: "Postal / ZIP code.",
  },
  {
    key: APP_CONFIG_KEYS.COMPANY_PHONE,
    scope: "global",
    section: "company",
    label: "Phone",
    value_type: "text",
    description: "Customer care phone on stickers.",
  },
  {
    key: APP_CONFIG_KEYS.COMPANY_EMAIL,
    scope: "global",
    section: "company",
    label: "Email",
    value_type: "text",
    description: "Support email on stickers.",
  },
  {
    key: APP_CONFIG_KEYS.COMPANY_GSTIN,
    scope: "global",
    section: "company",
    label: "GSTIN",
    value_type: "text",
    description: "Optional printed when provided.",
  },
  {
    key: APP_CONFIG_KEYS.INWARD_LOCATION_VALIDATION,
    scope: "ims",
    section: "application",
    label: "Inward location validation",
    value_type: "boolean",
    description:
      "When enabled, inward save runs extra location validation on the server.",
  },
  {
    key: APP_CONFIG_KEYS.DEFAULT_LIST_VIEW_SPAN_DAYS,
    scope: "ims",
    section: "application",
    label: "Default list date span (days)",
    value_type: "number",
    min: LIST_VIEW_SPAN_MIN,
    max: LIST_VIEW_SPAN_MAX,
    description:
      "Default number of days on list pages when the user has no view-day cap.",
  },
  {
    key: APP_CONFIG_KEYS.BOX_QR_PUBLIC_BASE_URL,
    scope: "ims",
    section: "application",
    label: "Box QR public URL base",
    value_type: "url",
    description:
      "Sticker QR opens this URL with ?id=box_uid. Leave empty to encode box UID only.",
  },
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
    return {
      ...def,
      config_value: row?.config_value ?? "",
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    };
  });
}

/** Super admin: list keys for a scope (global admin console or per-app). */
export const getAppConfigList = async (req, res) => {
  try {
    const scope = resolveAppConfigScope(req.body?.app ?? req.body?.scope);
    const rows = await getAllAppConfig();
    res.json({
      success: true,
      scope,
      sections: sectionsForScope(scope),
      data: mergeDefinitionsWithRows(rows, scope),
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

    await setAppConfigValue(config_key, normalized.value, { updated_by: req.user?.id ?? null });

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
