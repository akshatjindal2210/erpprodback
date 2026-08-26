/**
 * RM Store app settings (saved in ims_app_config).
 * Shown under: Settings → App Configuration → RM Store
 */

export const RMSTORE_STICKER_MODES = Object.freeze({
  COIL: "coil",
  BATCH: "batch",
});

export const RMSTORE_APP_CONFIG_KEYS = Object.freeze({
  /** coil = sticker per coil; batch = one QC sticker for the batch */
  MRN_STICKER_MODE: "mrn_sticker_mode",
  MRN_COIL_QTY_EDITABLE: "mrn_coil_qty_editable",
  MRN_COIL_QTY_AUTO_CALC: "mrn_coil_qty_auto_calc",
  /** Shared with IMS App Console (same DB keys) */
  LOCATION_VALIDATION: "inward_location_validation",
  LOCATION_CAPACITY_VALIDATION: "location_capacity_validation",
});

/**
 * Permanent product rule (not App Config):
 * MRN sticker generate is always blocked when RM Spec Master is missing for the item.
 */
export const MRN_STICKER_REQUIRE_SPEC = true;

/**
 * Permanent product rule (not App Config). Keep in sync with frontend app.config.js.
 * true  = machine is locked to the first issued job card until Store Out is authorized
 * false = multiple job cards may share a machine until RM qty is fulfilled
 */
export const ISSUE_REQUEST_MACHINE_JOB_CARD_LOCK = true;

export const RMSTORE_APP_CONFIG_SECTION = Object.freeze({
  id: "rmstore",
  scope: "rmstore",
  title: "Application settings",
  description: "RM Store app-level options.",
});

export const RMSTORE_APP_CONFIG_DEFINITIONS = Object.freeze([
  {
    key: RMSTORE_APP_CONFIG_KEYS.LOCATION_VALIDATION,
    scope: "rmstore",
    section: "rmstore",
    label: "Location validation",
    value_type: "boolean",
    description: "Enabled = check location item rules on store in. Disabled = no check.",
  },
  {
    key: RMSTORE_APP_CONFIG_KEYS.LOCATION_CAPACITY_VALIDATION,
    scope: "rmstore",
    section: "rmstore",
    label: "Capacity validation",
    value_type: "boolean",
    description: "Enabled = coils cannot exceed location capacity. Disabled = any qty OK.",
  },
  {
    key: RMSTORE_APP_CONFIG_KEYS.MRN_STICKER_MODE,
    scope: "rmstore",
    section: "rmstore",
    label: "QC sticker mode",
    value_type: "select",
    options: [
      { value: RMSTORE_STICKER_MODES.BATCH, label: "Batch-wise" },
      { value: RMSTORE_STICKER_MODES.COIL, label: "Coil-wise" },
    ],
    description:
      "Default is Batch-wise. Coil-wise = QC sticker download per coil row (same coil design). Batch-wise = one QC sticker for the batch (top button). Coil stickers always generate per coil.",
  },
  {
    key: RMSTORE_APP_CONFIG_KEYS.MRN_COIL_QTY_EDITABLE,
    scope: "rmstore",
    section: "rmstore",
    label: "Allow editing coil quantity",
    value_type: "boolean",
    description: "Enabled = user can change total / per-coil qty. Disabled = qty fields stay locked.",
  },
  {
    key: RMSTORE_APP_CONFIG_KEYS.MRN_COIL_QTY_AUTO_CALC,
    scope: "rmstore",
    section: "rmstore",
    label: "Auto-split coil quantities",
    value_type: "boolean",
    description:
      "Enabled = uneven system split (middle coils higher). Disabled = equal qty per coil when editing is locked, or manual entry when editing is allowed.",
  },
]);

export const RMSTORE_APP_CONFIG_SEEDS = Object.freeze({
  [RMSTORE_APP_CONFIG_KEYS.LOCATION_VALIDATION]: "false",
  [RMSTORE_APP_CONFIG_KEYS.LOCATION_CAPACITY_VALIDATION]: "false",
  [RMSTORE_APP_CONFIG_KEYS.MRN_STICKER_MODE]: RMSTORE_STICKER_MODES.BATCH,
  [RMSTORE_APP_CONFIG_KEYS.MRN_COIL_QTY_EDITABLE]: "true",
  [RMSTORE_APP_CONFIG_KEYS.MRN_COIL_QTY_AUTO_CALC]: "true",
});
