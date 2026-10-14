/**
 * Engineering app settings (saved in ims_app_config).
 * Shown under: Settings → App Configuration → Engineering
 * Frontend tab: frontend/src/apps/engineering/lib/config/app.config.js
 */

export const ENGINEERING_APP_CONFIG_KEYS = Object.freeze({
  /** true = RM can be changed per process in Prime Process Master; false = item default RM only (read-only) */
  PRIME_ITEM_RM_WIRE_SELECTABLE: "prime_item_rm_wire_selectable",
});

export const ENGINEERING_APP_CONFIG_SECTION = Object.freeze({
  id: "engineering",
  scope: "engineering",
  title: "Application settings",
  description: "Engineering app-level options.",
});

export const ENGINEERING_APP_CONFIG_DEFINITIONS = Object.freeze([
  {
    key: ENGINEERING_APP_CONFIG_KEYS.PRIME_ITEM_RM_WIRE_SELECTABLE,
    scope: "engineering",
    section: "engineering",
    label: "Prime / Finish — select RM items",
    value_type: "boolean",
    description: "Enabled (true) = RM dropdown per process (Item RM defaults pre-selected). Disabled (false) = default RM shown read-only, no select.",
  },
]);

export const ENGINEERING_APP_CONFIG_SEEDS = Object.freeze({
  [ENGINEERING_APP_CONFIG_KEYS.PRIME_ITEM_RM_WIRE_SELECTABLE]: "false",
});
