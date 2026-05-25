import dbQuery from "../config/db.js";
import { getBoxNoUidPrefixFromFinancialYear } from "../utils/indianFinancialYear.js";
import { getCachedAppConfig, setCachedAppConfig, invalidateAppConfigCache } from "../utils/appConfigCache.js";

/*
  Post-deploy settings (`app_config` table). Read at runtime from DB.
  Server infrastructure stays in `config/config.js` + `.env` only.
  First-time defaults: `config/seed.js` → `APP_CONFIG_SEEDS`.
*/

/** Stable keys for `app_config.config_key` (values as text). */
export const APP_CONFIG_KEYS = {
  INWARD_LOCATION_VALIDATION: "inward_location_validation",
  DEFAULT_LIST_VIEW_SPAN_DAYS: "default_list_view_span_days",
  BOX_QR_PUBLIC_BASE_URL: "box_qr_public_base_url",
  BOX_NO_UID_PREFIX: "box_no_uid_prefix",
  COMPANY_NAME: "company_name",
  COMPANY_ADDRESS: "company_address",
  COMPANY_PHONE: "company_phone",
  COMPANY_EMAIL: "company_email",
  COMPANY_GSTIN: "company_gstin",
  COMPANY_STATE: "company_state",
  COMPANY_PINCODE: "company_pincode",
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

/** Sticker header company block — reads `app_config` with hardcoded fallbacks. */
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
    // const state = cfg[APP_CONFIG_KEYS.COMPANY_STATE];
    const pincode = cfg[APP_CONFIG_KEYS.COMPANY_PINCODE];
    const addrBase = String(address ?? "").trim() || COMPANY_INFO_DEFAULTS.address;
    // const st = String(state ?? "").trim();
    const pin = String(pincode ?? "").trim();
    // const addressLine = [addrBase, st && pin ? `${st} - ${pin}` : st || pin].filter(Boolean).join(", ") || addrBase;
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

const LIST_VIEW_SPAN_MIN = 1;
const LIST_VIEW_SPAN_MAX = 3650;
const LIST_VIEW_SPAN_FALLBACK = 7;

export async function getAppConfigValue(config_key) {
  const key = String(config_key);
  const hit = getCachedAppConfig(key);
  if (hit !== undefined) return hit;

  const [row] = await dbQuery(
    `SELECT config_value FROM app_config WHERE config_key = $1 LIMIT 1`,
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
      `SELECT config_key, config_value FROM app_config WHERE config_key = ANY($1::text[])`,
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
     FROM app_config
     ORDER BY config_key ASC`
  );
  return rows || [];
}

export async function setAppConfigValue(config_key, config_value, { updated_by } = {}) {
  const key = String(config_key);
  await dbQuery(
    `INSERT INTO app_config (config_key, config_value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (config_key) DO UPDATE SET
       config_value = EXCLUDED.config_value,
       updated_at   = NOW(),
       updated_by   = EXCLUDED.updated_by`,
    [key, String(config_value ?? ""), updated_by ?? null]
  );
  invalidateAppConfigCache(key);
}
