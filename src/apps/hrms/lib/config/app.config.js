/**
 * HRMS app settings (saved in ims_app_config).
 * Settings → App Configuration → HRMS
 */

/** Always minutes. Validated on save (Admin → HRMS). */
export const HRMS_OVERTIME_BUFFER = Object.freeze({
  MIN: 10,
  MAX: 120,
  DEFAULT: 30,
});

export const HRMS_APP_CONFIG_KEYS = Object.freeze({
  OVERTIME_BUFFER_MINUTES: "hrms_overtime_buffer_minutes",
});

export const HRMS_APP_CONFIG_SECTION = Object.freeze({
  id: "hrms",
  scope: "hrms",
  title: "Application settings",
  description: "HRMS attendance and overtime options.",
});

export const HRMS_APP_CONFIG_DEFINITIONS = Object.freeze([
  {
    key: HRMS_APP_CONFIG_KEYS.OVERTIME_BUFFER_MINUTES,
    scope: "hrms",
    section: "hrms",
    label: "Overtime buffer (minutes)",
    value_type: "number",
    min: HRMS_OVERTIME_BUFFER.MIN,
    max: HRMS_OVERTIME_BUFFER.MAX,
    description: "Minutes only. Allowed 10–120 (max 2 hours). Grace before OT counts — e.g. 30 or 120.",
  },
]);

export const HRMS_APP_CONFIG_SEEDS = Object.freeze({
  [HRMS_APP_CONFIG_KEYS.OVERTIME_BUFFER_MINUTES]: String(HRMS_OVERTIME_BUFFER.DEFAULT),
});
