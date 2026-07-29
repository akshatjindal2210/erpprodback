/**
 * IMS app settings (saved in ims_app_config).
 * Shown under: Settings → App Configuration → IMS
 */

export const IMS_LIST_VIEW_SPAN = Object.freeze({
  MIN: 1,
  MAX: 3650,
  FALLBACK: 7,
});

export const IMS_APP_CONFIG_KEYS = Object.freeze({
  INWARD_LOCATION_VALIDATION: "inward_location_validation",
  DEFAULT_LIST_VIEW_SPAN_DAYS: "default_list_view_span_days",
  BOX_QR_PUBLIC_BASE_URL: "box_qr_public_base_url",
  BOX_NO_UID_PREFIX: "box_no_uid_prefix",
});

export const IMS_APP_CONFIG_SECTION = Object.freeze({
  id: "application",
  scope: "ims",
  title: "Application settings",
  description: "IMS-only options for all users.",
});

export const IMS_APP_CONFIG_DEFINITIONS = Object.freeze([
  {
    key: IMS_APP_CONFIG_KEYS.INWARD_LOCATION_VALIDATION,
    scope: "ims",
    section: "application",
    label: "Inward location validation",
    value_type: "boolean",
    description: "Enabled = extra location checks run when saving inward.",
  },
  {
    key: IMS_APP_CONFIG_KEYS.DEFAULT_LIST_VIEW_SPAN_DAYS,
    scope: "ims",
    section: "application",
    label: "Default list date span (days)",
    value_type: "number",
    min: IMS_LIST_VIEW_SPAN.MIN,
    max: IMS_LIST_VIEW_SPAN.MAX,
    description: "How many days list pages show by default (if the user has no view-day cap).",
  },
  {
    key: IMS_APP_CONFIG_KEYS.BOX_QR_PUBLIC_BASE_URL,
    scope: "ims",
    section: "application",
    label: "Box QR public URL",
    value_type: "url",
    description: "QR opens this URL with ?id=box_uid. Leave empty to encode only the box UID.",
  },
]);

export const IMS_APP_CONFIG_SEEDS = Object.freeze({
  [IMS_APP_CONFIG_KEYS.INWARD_LOCATION_VALIDATION]: "false",
  [IMS_APP_CONFIG_KEYS.DEFAULT_LIST_VIEW_SPAN_DAYS]: "7",
  [IMS_APP_CONFIG_KEYS.BOX_QR_PUBLIC_BASE_URL]: "https://jflindia.com/",
  [IMS_APP_CONFIG_KEYS.BOX_NO_UID_PREFIX]: "2026",
});
