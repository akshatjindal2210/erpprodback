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

export function isBoxEligibleForInward(box) {
  return isBoxInHand(box);
}

/** Minus list: in-hand + this adjustment's stock_out (edit); hide out-entry outward. */
export function isBoxVisibleForStockAdjustmentMinus(box, { adjustmentId = null } = {}) {
  if (!box || box.is_deleted) return false;
  if (isBoxInHand(box)) return true;
  const adjId = adjustmentId != null ? Number(adjustmentId) : null;
  if (Number.isFinite(adjId) && adjId > 0) {
    const sa = box.sa_id != null ? Number(box.sa_id) : null;
    if (sa === adjId && isBoxStockAdjustmentOut(box)) return true;
  }
  return false;
}

/** Available for minus selection (in-hand boxes, or this adjustment's pending stock_out rows). */
export function isBoxAvailableForMinus(box, { adjustmentId = null } = {}) {
  if (!box || box.is_deleted) return false;
  const adjId = adjustmentId != null ? Number(adjustmentId) : null;
  if (Number.isFinite(adjId) && adjId > 0) {
    const sa = box.sa_id != null ? Number(box.sa_id) : null;
    if (sa === adjId) {
      if (isBoxStockAdjustmentOut(box)) return true;
      if (isBoxInHand(box)) return true;
    }
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
  if (isBoxInHand(box)) return true;
  const scoped = forOutUid != null && String(forOutUid).trim() !== "" ? Number(forOutUid) : null;
  return Number.isFinite(scoped) && Number(box.out_uid) === scoped;
}
