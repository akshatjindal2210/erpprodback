/**
 * Box availability — `out_uid` + `sa_id` + `sa_entry_type`.
 *
 * 1. out_uid empty  → in hand (inventory)
 * 2. out_uid set + stock adjustment out (stock_out, or out_uid = sa_id) → not in hand
 * 3. out_uid set + outward dispatch (out entry) → not in hand
 */

export function isOutUidEmpty(box) {
  const out = box?.out_uid;
  return out == null || String(out).trim() === "";
}

export function isSaIdEmpty(box) {
  const sa = box?.sa_id ?? box?.stock_adjustment_id;
  return sa == null || String(sa).trim() === "";
}

export function isStockAdjustmentOut(box) {
  return String(box?.sa_entry_type ?? "").trim() === "stock_out";
}

export function isStockAdjustmentIn(box) {
  return String(box?.sa_entry_type ?? "").trim() === "stock_in";
}

/** Case 2 — stock adjustment minus (out_uid usually equals sa_id). */
export function isBoxStockAdjustmentOut(box) {
  if (!box || box.is_deleted) return false;
  if (isStockAdjustmentOut(box)) return true;
  if (isOutUidEmpty(box)) return false;
  if (isSaIdEmpty(box)) return false;
  const out = Number(box.out_uid);
  const sa = Number(box.sa_id ?? box.stock_adjustment_id);
  return Number.isFinite(out) && Number.isFinite(sa) && out === sa;
}

/** Case 3 — outward / out entry (out_uid set, not SA minus pattern). */
export function isBoxOutwardDispatch(box) {
  if (!box || box.is_deleted) return false;
  if (isOutUidEmpty(box)) return false;
  return !isBoxStockAdjustmentOut(box);
}

/** Case 1 — in hand; eligible for store inward / inventory counts. */
export function isBoxInHand(box) {
  if (!box || box.is_deleted) return false;
  if (!isOutUidEmpty(box)) return false;
  if (isStockAdjustmentOut(box)) return false;
  return true;
}

export function isBoxOnQcHold(box) {
  const id = box?.qc_hold_id;
  return id != null && String(id).trim() !== "";
}

/** Box is in store (has location or inward), not packing / QC floor. */
export function isBoxInStore(box) {
  if (!box) return false;
  const hasLocation = box.location_id != null && String(box.location_id).trim() !== "";
  const hasInward = box.in_uid != null && String(box.in_uid).trim() !== "";
  return hasLocation || hasInward;
}

/** Available sellable stock — in hand and not on QC hold. */
export function isBoxSellable(box) {
  return isBoxInHand(box) && !isBoxOnQcHold(box);
}

export function isBoxEligibleForInward(box) {
  return isBoxSellable(box);
}

// Customer override: allow in-hand and outward boxes; block deleted and SA minus (removed) only.
export function isBoxEligibleForOverrideCustomer(box) {
  if (!box || box.is_deleted) return false;
  if (isStockAdjustmentOut(box) || isBoxStockAdjustmentOut(box)) return false;
  return true;
}

export function overrideCustomerScanRejectMessage(box) {
  if (!box || box.is_deleted) return "Box not found or was removed.";
  if (isStockAdjustmentOut(box) || isBoxStockAdjustmentOut(box)) {
    return "This box was removed via stock adjustment (minus) and cannot be used for customer override.";
  }
  return "Box is not available for customer override.";
}

function isMinusMarkedForAdjustment(box, adjustmentId) {
  const adjId = adjustmentId != null ? Number(adjustmentId) : null;
  if (!Number.isFinite(adjId) || adjId <= 0) return false;
  const sa = box.sa_id != null ? Number(box.sa_id) : null;
  if (sa === adjId && isBoxStockAdjustmentOut(box)) return true;
  const out = Number(box.out_uid);
  return Number.isFinite(out) && out === adjId;
}

/** Packing column or SA sticker id (`{pn}_SA{adjId}_…`). */
export function boxBelongsToPackingNumber(box, packingNumber) {
  const pn = packingNumber != null ? String(packingNumber).trim() : "";
  if (!pn || !box) return false;
  const col = String(box.packing_number ?? "").trim();
  if (col === pn) return true;
  if (col && /^\d+$/.test(col) && /^\d+$/.test(pn) && Number(col) === Number(pn)) {
    return true;
  }
  const uid = String(box.box_no_uid ?? "");
  return uid.includes(`_${pn}_SA`);
}

/** Minus list: in-hand + this adjustment's stock_out (edit); hide out-entry outward. */
export function isBoxVisibleForStockAdjustmentMinus(box, { adjustmentId = null } = {}) {
  if (!box || box.is_deleted) return false;
  if (isBoxInHand(box)) return true;
  return isMinusMarkedForAdjustment(box, adjustmentId);
}

/** Available for minus selection (in-hand boxes, or this adjustment's pending stock_out rows). */
export function isBoxAvailableForMinus(box, { adjustmentId = null } = {}) {
  if (!box || box.is_deleted) return false;
  const adjId = adjustmentId != null ? Number(adjustmentId) : null;
  if (Number.isFinite(adjId) && adjId > 0) {
    const sa = box.sa_id != null ? Number(box.sa_id) : null;
    if (sa === adjId && isBoxInHand(box)) return true;
    if (isMinusMarkedForAdjustment(box, adjId)) return true;
  }
  if (isBoxStockAdjustmentOut(box)) return false;
  return isBoxInHand(box);
}

export function boxInventoryStatus(box) {
  if (!box || box.is_deleted) return "deleted";
  if (isBoxStockAdjustmentOut(box)) return "stock_adjustment";
  if (isBoxInHand(box)) return "in_hand";
  if (isBoxOutwardDispatch(box)) return "outward";
  return "outward";
}

/** May be linked to an out entry (excludes outward + SA minus). */
export function isBoxAvailableForOutEntryScan(box, { forOutUid = null } = {}) {
  if (!box || box.is_deleted) return false;
  if (isBoxStockAdjustmentOut(box)) return false;
  if (isBoxSellable(box)) return true;
  const scoped = forOutUid != null && String(forOutUid).trim() !== "" ? Number(forOutUid) : null;
  return Number.isFinite(scoped) && Number(box.out_uid) === scoped;
}
