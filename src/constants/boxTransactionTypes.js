/** Stored in `transaction_box.transaction_type` */
export const BOX_TX_TYPES = {
  PACKING_CREATE: "packing_create",
  PACKING_DELETE: "packing_delete",
  INWARD_LINK: "inward_link",
  INWARD_UNLINK: "inward_unlink",
  OUT_LINK: "out_link",
  OUT_UNLINK: "out_unlink",
  SA_STOCK_IN: "sa_stock_in",
  SA_STOCK_OUT: "sa_stock_out",
  SA_REVERT: "sa_revert",
  SA_DELETE: "sa_delete",
  SA_QTY_UPDATE: "sa_qty_update",
  BOX_SOFT_DELETE: "box_soft_delete",
  OVERRIDE_CUSTOMER: "override_customer",
};

/** Simple labels for the logs UI (no link/unlink wording). */
export const BOX_TX_TYPE_LABELS = {
  [BOX_TX_TYPES.PACKING_CREATE]: "Stickers created",
  [BOX_TX_TYPES.PACKING_DELETE]: "Stickers removed",
  [BOX_TX_TYPES.INWARD_LINK]: "Store In — assigned",
  [BOX_TX_TYPES.INWARD_UNLINK]: "Store In — removed",
  [BOX_TX_TYPES.OUT_LINK]: "Store Out — dispatched",
  [BOX_TX_TYPES.OUT_UNLINK]: "Store Out — returned",
  [BOX_TX_TYPES.SA_STOCK_IN]: "Adjustment — boxes added",
  [BOX_TX_TYPES.SA_STOCK_OUT]: "Adjustment — boxes removed",
  [BOX_TX_TYPES.SA_REVERT]: "Adjustment — undone",
  [BOX_TX_TYPES.SA_DELETE]: "Adjustment — boxes deleted",
  [BOX_TX_TYPES.SA_QTY_UPDATE]: "Adjustment — qty changed",
  [BOX_TX_TYPES.BOX_SOFT_DELETE]: "Box deleted",
  [BOX_TX_TYPES.OVERRIDE_CUSTOMER]: "Customer override",
};
