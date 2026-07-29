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
  /** When true, MRN sticker generate requires RM Spec Master for the item */
  MRN_STICKER_REQUIRE_SPEC: "mrn_sticker_require_spec",
});

export const RMSTORE_APP_CONFIG_SECTION = Object.freeze({
  id: "rmstore",
  scope: "rmstore",
  title: "MRN / coil settings",
  description: "Controls QC sticker mode and how coil quantities work when generating MRN stickers.",
});

export const RMSTORE_APP_CONFIG_DEFINITIONS = Object.freeze([
  {
    key: RMSTORE_APP_CONFIG_KEYS.MRN_STICKER_MODE,
    scope: "rmstore",
    section: "rmstore",
    label: "QC sticker mode",
    value_type: "select",
    options: [
      { value: RMSTORE_STICKER_MODES.COIL, label: "Coil-wise" },
      { value: RMSTORE_STICKER_MODES.BATCH, label: "Batch-wise" },
    ],
    description:
      "Coil-wise = QC sticker download per coil row (same coil design). Batch-wise = one QC sticker for the batch (top button). Coil stickers always generate per coil.",
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
  {
    key: RMSTORE_APP_CONFIG_KEYS.MRN_STICKER_REQUIRE_SPEC,
    scope: "rmstore",
    section: "rmstore",
    label: "Require RM Spec for sticker generate",
    value_type: "boolean",
    description:
      "Enabled = MRN sticker generate is blocked if the item has no RM Spec Master (or item is missing). Disabled = stickers generate without spec check.",
  },
]);

export const RMSTORE_APP_CONFIG_SEEDS = Object.freeze({
  [RMSTORE_APP_CONFIG_KEYS.MRN_STICKER_MODE]: RMSTORE_STICKER_MODES.COIL,
  [RMSTORE_APP_CONFIG_KEYS.MRN_COIL_QTY_EDITABLE]: "true",
  [RMSTORE_APP_CONFIG_KEYS.MRN_COIL_QTY_AUTO_CALC]: "true",
  [RMSTORE_APP_CONFIG_KEYS.MRN_STICKER_REQUIRE_SPEC]: "false",
});
