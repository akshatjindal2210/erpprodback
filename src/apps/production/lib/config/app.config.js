/**
 * Production app settings (saved in ims_app_config).
 * Shown under: Settings → App Configuration → Production
 * Frontend tab: frontend/src/apps/production/lib/config/app.config.js
 */

export const PRODUCTION_APP_CONFIG_KEYS = Object.freeze({
  /** true = tooling must be Yes before saving process plan on Maintain Job Card */
  MAINTAIN_JOBCARD_TOOLING_REQUIRED: "production_maintain_jobcard_tooling_required",
});

export const PRODUCTION_APP_CONFIG_SECTION = Object.freeze({
  id: "production",
  scope: "production",
  title: "Application settings",
  description: "Production app-level options.",
});

export const PRODUCTION_APP_CONFIG_DEFINITIONS = Object.freeze([
  {
    key: PRODUCTION_APP_CONFIG_KEYS.MAINTAIN_JOBCARD_TOOLING_REQUIRED,
    scope: "production",
    section: "production",
    label: "Maintain Job Card — tooling required",
    value_type: "boolean",
    description: "Enabled (true) = process plan cannot be saved until tooling is Yes in Production → Tooling. Disabled (false) = tooling not required at save.",
  },
]);

export const PRODUCTION_APP_CONFIG_SEEDS = Object.freeze({
  [PRODUCTION_APP_CONFIG_KEYS.MAINTAIN_JOBCARD_TOOLING_REQUIRED]: "false",
});
