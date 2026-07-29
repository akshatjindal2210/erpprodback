import dbQuery from "../../../../config/db/db.js";
import { getBoxNoUidPrefixFromFinancialYear } from "../../lib/utils/date/indianFinancialYear.js";
import { getCachedAppConfig, setCachedAppConfig, invalidateAppConfigCache } from "../../lib/utils/config/appConfigCache.js";
import { CORE_APP_CONFIG_KEYS } from "../app.config.js";
import { IMS_APP_CONFIG_KEYS, IMS_LIST_VIEW_SPAN } from "../../../ims/lib/config/app.config.js";
// import { RMSTORE_APP_CONFIG_KEYS } from "../../../rmstore/lib/config/app.config.js";

/*
  Post-deploy settings (`ims_app_config` table). Read at runtime from DB.
  Server infrastructure stays in `config/config.js` + `.env` only.
  First-time defaults: per-app `app.config.js` seeds (merged in IMS seed).
*/

/** Stable keys for `ims_app_config.config_key` (values as text). */
export const APP_CONFIG_KEYS = {
  ...CORE_APP_CONFIG_KEYS,
  ...IMS_APP_CONFIG_KEYS,
  // ...RMSTORE_APP_CONFIG_KEYS,
};

const COMPANY_INFO_DEFAULTS = Object.freeze({
  name: "H.P. FASTENERS PVT. LTD.",
  address: "PLOT NO. 314, SECTOR-24, FARIDABAD (HR)-121005",
  phone: "",
  email: "info@jflindia.com",
  gstin: "",
  state: "Haryana",
  pincode: "121005",
});

/** Sticker header company block — reads `ims_app_config` with hardcoded fallbacks. */
export async function getStickerCompanyInfo() {
  try {
    const cfg = await getAppConfigValues([
      APP_CONFIG_KEYS.COMPANY_NAME,
      APP_CONFIG_KEYS.COMPANY_ADDRESS,
      APP_CONFIG_KEYS.COMPANY_PHONE,
      APP_CONFIG_KEYS.COMPANY_EMAIL,
      APP_CONFIG_KEYS.COMPANY_GSTIN,
      // APP_CONFIG_KEYS.COMPANY_STATE,
      APP_CONFIG_KEYS.COMPANY_PINCODE,
    ]);
    const name = cfg[APP_CONFIG_KEYS.COMPANY_NAME];
    const address = cfg[APP_CONFIG_KEYS.COMPANY_ADDRESS];
    const phone = cfg[APP_CONFIG_KEYS.COMPANY_PHONE];
    const email = cfg[APP_CONFIG_KEYS.COMPANY_EMAIL];
    const gstin = cfg[APP_CONFIG_KEYS.COMPANY_GSTIN];
    const pincode = cfg[APP_CONFIG_KEYS.COMPANY_PINCODE];
    const addrBase = String(address ?? "").trim() || COMPANY_INFO_DEFAULTS.address;
    const pin = String(pincode ?? "").trim();
    return {
      name: String(name ?? "").trim() || COMPANY_INFO_DEFAULTS.name,
      address: addrBase,
      // address: addressLine,
      phone: String(phone ?? "").trim(),
      email: String(email ?? "").trim() || COMPANY_INFO_DEFAULTS.email,
      gstin: String(gstin ?? "").trim(),
      pincode: pin,
    };
  } catch {
    return { ...COMPANY_INFO_DEFAULTS };
  }
}

const LIST_VIEW_SPAN_MIN = IMS_LIST_VIEW_SPAN.MIN;
const LIST_VIEW_SPAN_MAX = IMS_LIST_VIEW_SPAN.MAX;
const LIST_VIEW_SPAN_FALLBACK = IMS_LIST_VIEW_SPAN.FALLBACK;

export async function getAppConfigValue(config_key) {
  const key = String(config_key);
  const hit = getCachedAppConfig(key);
  if (hit !== undefined) return hit;

  const [row] = await dbQuery(
    `SELECT config_value FROM ims_app_config WHERE config_key = $1 LIMIT 1`,
    [key]
  );
  const value = row?.config_value ?? null;
  setCachedAppConfig(key, value);
  return value;
}

/** One round-trip for multiple keys (uses per-key cache). */
export async function getAppConfigValues(config_keys = []) {
  const keys = [...new Set((config_keys || []).map((k) => String(k)).filter(Boolean))];
  const out = {};
  const missing = [];

  for (const key of keys) {
    const hit = getCachedAppConfig(key);
    if (hit !== undefined) out[key] = hit;
    else missing.push(key);
  }

  if (missing.length > 0) {
    const rows = await dbQuery(
      `SELECT config_key, config_value FROM ims_app_config WHERE config_key = ANY($1::text[])`,
      [missing]
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.config_key, r.config_value ?? null]));
    for (const key of missing) {
      const value = byKey[key] ?? null;
      setCachedAppConfig(key, value);
      out[key] = value;
    }
  }

  return out;
}

/** Prefix for new sticker `box_no_uid` values — from current Indian FY (e.g. FY 2026-2027 → `26`). */
export async function getBoxNoUidPrefix() {
  return getBoxNoUidPrefixFromFinancialYear();
}

export async function getDefaultListViewSpanDays() {
  try {
    const raw = await getAppConfigValue(APP_CONFIG_KEYS.DEFAULT_LIST_VIEW_SPAN_DAYS);
    if (raw != null && String(raw).trim() !== "") {
      const n = parseInt(String(raw).trim(), 10);
      if (Number.isFinite(n)) {
        return Math.max(LIST_VIEW_SPAN_MIN, Math.min(LIST_VIEW_SPAN_MAX, n));
      }
    }
  } catch {
    /* table missing */
  }
  return LIST_VIEW_SPAN_FALLBACK;
}

/** Upsert; `config_value` stored as text (e.g. "true", "false"). */
export async function getAllAppConfig() {
  const rows = await dbQuery(
    `SELECT config_key, config_value, updated_at, updated_by
     FROM ims_app_config
     ORDER BY config_key ASC`
  );
  return rows || [];
}

export async function setAppConfigValue(config_key, config_value, { updated_by } = {}) {
  const key = String(config_key);
  await dbQuery(
    `INSERT INTO ims_app_config (config_key, config_value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (config_key) DO UPDATE SET
       config_value = EXCLUDED.config_value,
       updated_at   = NOW(),
       updated_by   = EXCLUDED.updated_by`,
    [key, String(config_value ?? ""), updated_by ?? null]
  );
  invalidateAppConfigCache(key);
}

/** Whether inward location–box rules are enforced (IMS app config + env fallback). */
export async function isInwardLocationValidationEnabled() {
  try {
    const raw = await getAppConfigValue(APP_CONFIG_KEYS.INWARD_LOCATION_VALIDATION);
    if (raw != null && String(raw).trim() !== "") {
      return String(raw).trim().toLowerCase() === "true";
    }
  } catch {
    /* e.g. `ims_app_config` not created yet */
  }
  const envRaw = process.env.INWARD_LOCATION_VALIDATION;
  if (envRaw != null && String(envRaw).trim() !== "") {
    return String(envRaw).toLowerCase() === "true";
  }
  return false;
}

/** When true, MRN sticker modal allows editing total / per-coil qty (default true). */
export async function getMrnCoilQtyEditable() {
  try {
    const raw = await getAppConfigValue(APP_CONFIG_KEYS.MRN_COIL_QTY_EDITABLE);
    if (raw == null || String(raw).trim() === "") return true;
    return String(raw).trim().toLowerCase() === "true";
  } catch {
    return true;
  }
}

/** When true, system auto-splits coil qtys; when false, user enters manually (default true). */
export async function getMrnCoilQtyAutoCalc() {
  try {
    const raw = await getAppConfigValue(APP_CONFIG_KEYS.MRN_COIL_QTY_AUTO_CALC);
    if (raw == null || String(raw).trim() === "") return true;
    return String(raw).trim().toLowerCase() === "true";
  } catch {
    return true;
  }
}

/** MRN sticker mode: `coil` (per coil) or `batch` (one QC sticker for the batch). Default `coil`. */
export async function getMrnStickerMode() {
  try {
    const raw = await getAppConfigValue(APP_CONFIG_KEYS.MRN_STICKER_MODE);
    const mode = String(raw || "").trim().toLowerCase();
    if (mode === "batch") return "batch";
    return "coil";
  } catch {
    return "coil";
  }
}

/** When true, block MRN sticker generate if item missing or has no RM Spec Master. Default false. */
export async function getMrnStickerRequireSpec() {
  try {
    const raw = await getAppConfigValue(APP_CONFIG_KEYS.MRN_STICKER_REQUIRE_SPEC);
    if (raw == null || String(raw).trim() === "") return false;
    return String(raw).trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}
