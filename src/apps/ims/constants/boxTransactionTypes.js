/** Stored in `ims_transaction_box.transaction_type` */
export const BOX_TX_TYPES = {
  PACKING_CREATE: "packing_create",
  PACKING_DELETE: "packing_delete",
  INWARD_LINK: "inward_link",
  INWARD_UNLINK: "inward_unlink",
  OUT_LINK: "out_link",
  OUT_UNLINK: "out_unlink",
  OUT_OTHER_RETURN_TO_PACKING: "out_other_return_to_packing",
  SA_STOCK_IN: "sa_stock_in",
  SA_STOCK_OUT: "sa_stock_out",
  SA_REVERT: "sa_revert",
  SA_DELETE: "sa_delete",
  SA_QTY_UPDATE: "sa_qty_update",
  BOX_SOFT_DELETE: "box_soft_delete",
  OVERRIDE_CUSTOMER: "override_customer",
};

/** Simple Add / Remove labels for the logs UI (Out dispatch unchanged). */
export const BOX_TX_TYPE_LABELS = {
  [BOX_TX_TYPES.PACKING_CREATE]: "Stickers — Add",
  [BOX_TX_TYPES.PACKING_DELETE]: "Stickers — Remove",
  [BOX_TX_TYPES.INWARD_LINK]: "Store In — Add",
  [BOX_TX_TYPES.INWARD_UNLINK]: "Store In — Remove",
  [BOX_TX_TYPES.OUT_LINK]: "Out — Dispatched",
  [BOX_TX_TYPES.OUT_UNLINK]: "Out — Return",
  [BOX_TX_TYPES.OUT_OTHER_RETURN_TO_PACKING]: "Out (Other) — Return to packing",
  [BOX_TX_TYPES.SA_STOCK_IN]: "Adjustment — Add",
  [BOX_TX_TYPES.SA_STOCK_OUT]: "Adjustment — Remove",
  [BOX_TX_TYPES.SA_REVERT]: "Adjustment — Remove",
  [BOX_TX_TYPES.SA_DELETE]: "Adjustment — Remove",
  [BOX_TX_TYPES.SA_QTY_UPDATE]: "Adjustment — Qty change",
  [BOX_TX_TYPES.BOX_SOFT_DELETE]: "Box — Remove",
  [BOX_TX_TYPES.OVERRIDE_CUSTOMER]: "Customer override",
};
