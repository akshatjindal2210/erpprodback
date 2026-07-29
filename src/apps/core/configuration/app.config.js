/**
 * Core / Admin Console settings (saved in ims_app_config).
 * Shown under: Settings → App Configuration → Admin Console / Shortcut
 */

export const CORE_APP_CONFIG_KEYS = Object.freeze({
  COMPANY_NAME: "company_name",
  COMPANY_ADDRESS: "company_address",
  COMPANY_PHONE: "company_phone",
  COMPANY_EMAIL: "company_email",
  COMPANY_GSTIN: "company_gstin",
  COMPANY_STATE: "company_state",
  COMPANY_PINCODE: "company_pincode",
  DYNAMIC_SHORTCUTS: "dynamic_shortcuts",
});

export const CORE_APP_CONFIG_SECTIONS = Object.freeze([
  {
    id: "company",
    scope: "global",
    title: "Company details",
    description: "Shown on stickers and shared across apps.",
  },
  {
    id: "shortcut",
    scope: "global",
    title: "Shortcut settings",
    description: "Home / sidenav shortcut links.",
  },
]);

export const CORE_APP_CONFIG_DEFINITIONS = Object.freeze([
  {
    key: CORE_APP_CONFIG_KEYS.COMPANY_NAME,
    scope: "global",
    section: "company",
    label: "Company name",
    value_type: "text",
    description: "Name printed on stickers.",
  },
  {
    key: CORE_APP_CONFIG_KEYS.COMPANY_ADDRESS,
    scope: "global",
    section: "company",
    label: "Street address",
    value_type: "text",
    description: "Address line printed on stickers.",
  },
  {
    key: CORE_APP_CONFIG_KEYS.COMPANY_STATE,
    scope: "global",
    section: "company",
    label: "State",
    value_type: "text",
    description: "State / region.",
  },
  {
    key: CORE_APP_CONFIG_KEYS.COMPANY_PINCODE,
    scope: "global",
    section: "company",
    label: "Pincode",
    value_type: "text",
    description: "Postal / ZIP code.",
  },
  {
    key: CORE_APP_CONFIG_KEYS.COMPANY_PHONE,
    scope: "global",
    section: "company",
    label: "Phone",
    value_type: "text",
    description: "Phone number on stickers.",
  },
  {
    key: CORE_APP_CONFIG_KEYS.COMPANY_EMAIL,
    scope: "global",
    section: "company",
    label: "Email",
    value_type: "text",
    description: "Email on stickers.",
  },
  {
    key: CORE_APP_CONFIG_KEYS.COMPANY_GSTIN,
    scope: "global",
    section: "company",
    label: "GSTIN",
    value_type: "text",
    description: "Optional. Printed only if filled.",
  },
  {
    key: CORE_APP_CONFIG_KEYS.DYNAMIC_SHORTCUTS,
    scope: "global",
    section: "shortcut",
    label: "Dynamic Shortcuts JSON",
    value_type: "text",
    description: "Managed from the Shortcut tab UI.",
  },
]);

export const CORE_APP_CONFIG_SEEDS = Object.freeze({
  [CORE_APP_CONFIG_KEYS.COMPANY_NAME]: "H.P. FASTENERS PVT. LTD.",
  [CORE_APP_CONFIG_KEYS.COMPANY_ADDRESS]: "PLOT NO. 314, SECTOR-24, FARIDABAD (HR)-121005",
  [CORE_APP_CONFIG_KEYS.COMPANY_PHONE]: "8505859996",
  [CORE_APP_CONFIG_KEYS.COMPANY_EMAIL]: "info@jflindia.com",
  [CORE_APP_CONFIG_KEYS.COMPANY_GSTIN]: "",
  [CORE_APP_CONFIG_KEYS.COMPANY_STATE]: "Haryana",
  [CORE_APP_CONFIG_KEYS.COMPANY_PINCODE]: "121005",
});
