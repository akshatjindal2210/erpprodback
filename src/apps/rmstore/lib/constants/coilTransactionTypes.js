/** Stored in `rmstore_coil_transaction.transaction_type` */
export const COIL_TX_TYPES = {
  STICKER_CREATE: "sticker_create",
  STICKER_DELETE: "sticker_delete",
  INWARD_LINK: "inward_link",
  INWARD_UNLINK: "inward_unlink",
  STORE_OUT: "store_out",
  STORE_OUT_REVERT: "store_out_revert",
  QC_CHECK_PASS: "qc_check_pass",
  QC_CHECK_FAIL: "qc_check_fail",
  QC_REJECT: "qc_reject",
  QC_REJECT_REVERT: "qc_reject_revert",
  STOCK_ADJUSTMENT_ADD: "stock_adjustment_add",
  STOCK_ADJUSTMENT_MINUS: "stock_adjustment_minus",
  STOCK_ADJUSTMENT_ADD_REVERT: "stock_adjustment_add_revert",
  STOCK_ADJUSTMENT_MINUS_REVERT: "stock_adjustment_minus_revert",
  CONSUME: "consume",
  CONSUME_REVERT: "consume_revert",
  /** Kept out of the main transaction list — it has its own download-log view. */
  STICKER_DOWNLOAD: "sticker_download",
};

/** Simple Add / Remove labels for the logs UI (Store Out dispatch unchanged). */
export const COIL_TX_TYPE_LABELS = {
  [COIL_TX_TYPES.STICKER_CREATE]: "Stickers — Add",
  [COIL_TX_TYPES.STICKER_DELETE]: "Stickers — Remove",
  [COIL_TX_TYPES.INWARD_LINK]: "Store In — Add",
  [COIL_TX_TYPES.INWARD_UNLINK]: "Store In — Remove",
  [COIL_TX_TYPES.STORE_OUT]: "Store Out — Dispatched",
  [COIL_TX_TYPES.STORE_OUT_REVERT]: "Store Out — Return",
  [COIL_TX_TYPES.QC_CHECK_PASS]: "QC Check — Pass",
  [COIL_TX_TYPES.QC_CHECK_FAIL]: "QC Check — Fail",
  [COIL_TX_TYPES.QC_REJECT]: "QC Rejection — Remove",
  [COIL_TX_TYPES.QC_REJECT_REVERT]: "QC Rejection — Add",
  [COIL_TX_TYPES.STOCK_ADJUSTMENT_ADD]: "Adjustment — Add",
  [COIL_TX_TYPES.STOCK_ADJUSTMENT_MINUS]: "Adjustment — Remove",
  [COIL_TX_TYPES.STOCK_ADJUSTMENT_ADD_REVERT]: "Adjustment — Remove",
  [COIL_TX_TYPES.STOCK_ADJUSTMENT_MINUS_REVERT]: "Adjustment — Add",
  [COIL_TX_TYPES.CONSUME]: "Consume — Remove",
  [COIL_TX_TYPES.CONSUME_REVERT]: "Consume — Add",
  [COIL_TX_TYPES.STICKER_DOWNLOAD]: "Stickers — Download",
};
