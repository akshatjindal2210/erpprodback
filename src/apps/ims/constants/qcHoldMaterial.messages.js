/** QC Hold Material — API / validation messages (English only). */

export const QC_HOLD_MSG = {
  PACKING_NUMBER_REQUIRED: "packing_number required",
  BOX_NO_UID_REQUIRED: "box_no_uid required",
  BOX_NOT_FOUND: "Box not found",
  BOX_ALREADY_ON_QC_HOLD: "Box is already on QC hold",
  BOX_NOT_IN_STORE_INVENTORY: "Box is not in in-hand stock (outward/dispatch or not in store)",
  HOLD_ID_REQUIRED: "hold_id required",
  NOT_FOUND: "Not found",
  NO_SELLABLE_BOXES_FOR_PACKING: "No in-hand stock boxes found for this packing (outward or already on hold are excluded)",
  SCAN_BOX_OR_PACKING: "Scan at least one box or enter packing number",
  ITEM_REQUIRED: "Item is required",
  VALID_QTY_REQUIRED: "Valid quantity is required",
  REASON_REQUIRED: "Reason is required",
  NO_BOXES_TO_HOLD: "No boxes to hold",
  PENDING_HOLD_SAVED: "Hold saved — boxes removed from inventory and linked to QC Hold",
  SUBMISSION_TYPE_INVALID: "submission_type must be partial, full, or revert",
  PARTIAL_SUBMIT_DISABLED: "Partial submit is disabled. Use Full Submit.",
  PARTIAL_HOLD_DISABLED: "Partial hold scan is disabled. Use Full Hold.",
  REVERT_MUST_USE_FULL_BALANCE: "Revert must release the entire hold balance.",
  REVERT_NO_REJECT: "Rejected quantity is not allowed on revert.",
  REVERT_NO_BOXES_ON_HOLD:
    "No boxes are linked to this hold anymore. They may have been dispatched, moved out, or already cleared — revert is not possible.",
  REVERT_APPROVED: "Revert approved — boxes returned to stock with no sticker or location change.",
  HOLD_NOT_FOUND: "Hold not found",
  ONLY_PENDING_CAN_SUBMIT: "Only pending holds can receive submissions",
  NO_BALANCE_LEFT: "No balance left on this hold",
  SUBMISSION_ALREADY_AWAITING: "A submission is already awaiting approval. Approve it before submitting again.",
  SUBMITTED_AWAITING_APPROVAL: "Submitted — waiting for super admin approval",
  HOLD_ID_WITH_SUBMISSION_REQUIRED: "hold_id required with submission_id",
  NO_PENDING_SUBMISSION: "No pending submission found",
  SUBMISSION_ALREADY_APPROVED: "Submission already approved",
  INVALID_SUBMISSION_TYPE: "Invalid submission type",
  COULD_NOT_APPROVE_SUBMISSION: "Could not approve submission",
  SUBMISSION_APPROVED: "Submission approved",
  QC_HOLD_UPDATED: "QC hold updated — box list synced with inventory",
  QC_HOLD_DELETED: "QC hold deleted",
  ENTER_COMPLETED_QTY: "Enter completed quantity.",
  REJECTED_ONLY_ON_FINAL: "Rejected quantity is only allowed on final submit.",
  ENTER_COMPLETED_FOR_APPROVAL: "Enter completed quantity to request approval.",
};

export function qcHoldBoxBelongsToPacking(boxPn, pn) {
  return `Box belongs to packing #${boxPn}, not #${pn}`;
}

export function qcHoldBoxNotFound(uid) {
  return `Box not found: ${uid}`;
}

export function qcHoldBoxAlreadyOnHold(boxLabel, uid) {
  return `Box ${boxLabel || uid} is already on QC hold`;
}

export function qcHoldBoxNotSellable(boxLabel, uid) {
  return `Box ${boxLabel || uid} is not in sellable stock`;
}

export function qcHoldBoxWrongPacking(boxLabel, uid, boxPn, pn) {
  return `Box ${boxLabel || uid} belongs to packing #${boxPn}, not #${pn}`;
}

export function qcHoldCompletedExceedsBalance(completedQty, balanceQty) {
  return `Completed quantity (${completedQty}) cannot exceed the hold balance (${balanceQty}).`;
}

export function qcHoldRejectedExceedsBalance(rejectedQty, balanceQty) {
  return `Rejected quantity (${rejectedQty}) cannot exceed the hold balance (${balanceQty}).`;
}

export function qcHoldCombinedExceedsBalance(totalOutQty, balanceQty) {
  return `Completed and rejected quantity combined (${totalOutQty}) exceeds the balance left (${balanceQty}).`;
}

export function qcHoldFullSubmitMustUseBalance(balanceQty) {
  return `Full submit must use the entire balance: ${balanceQty} qty.`;
}
