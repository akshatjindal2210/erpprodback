import { roundSaQty } from "./stockAdjustmentQty.js";
import { sumApprovedAddCoilQtyForAdjustment, sumCoilQtyForMrn } from "../../coil/models/coil.model.js";
import { sumPendingAddQtyForMrn } from "../models/stockAdjustment.model.js";
import { findMrnByUid } from "../../mrn/models/mrn.model.js";
import { fetchErpMrnByKey } from "../../mrn/utils/resolveMrnForSticker.js";

/**
 * Resolve the MRN receipt cap for Stock Adjustment / MRN search.
 * Prefer the highest trustworthy receipt among FE hint (ERP-sourced), ERP, and local MRN.
 */
export async function resolveMrnReceiptQtyForBudget(mrn_uid, receiptQtyHint = null) {
  const hint = roundSaQty(receiptQtyHint);
  const uid = String(mrn_uid || "").trim();
  if (!uid) {
    return Number.isFinite(hint) && hint > 0 ? hint : 0;
  }

  let erpQty = 0;
  let localQty = 0;

  try {
    const erp = await fetchErpMrnByKey(uid);
    erpQty = roundSaQty(erp?.it_recp_qty);
  } catch {
    /* ERP lookup optional */
  }

  try {
    const local = await findMrnByUid(uid);
    localQty = roundSaQty(local?.it_recp_qty);
  } catch {
    /* local MRN optional */
  }

  const candidates = [hint, erpQty, localQty].filter((n) => Number.isFinite(n) && n > 0);
  if (!candidates.length) return 0;
  return Math.max(...candidates);
}

/**
 * MRN qty budget for Stock Adjustment Add (+) and MRN search:
 *   remaining = receipt − allocated coil qty (portal + approved SA, incl. partial consume) − pending SA Add
 * Approved SA qty lives in coil rows — not double-counted via adjustment sum.
 */
export async function computeMrnQtyBudget(mrn_uid, { receiptQty, excludeAdjustmentId = null } = {}) {
  const uid = String(mrn_uid || "").trim();
  const receipt = await resolveMrnReceiptQtyForBudget(uid, receiptQty);
  if (!uid || !Number.isFinite(receipt) || receipt <= 0) {
    return {
      receipt_qty: receipt || 0,
      coil_used_qty: 0,
      pending_sa_add_qty: 0,
      prior_add_qty: 0,
      remaining_qty: Math.max(0, receipt || 0),
    };
  }

  let coilUsedQty = roundSaQty(await sumCoilQtyForMrn(uid));
  const excludeId = Number(excludeAdjustmentId);
  let excludedSaCoilQty = 0;
  if (Number.isFinite(excludeId) && excludeId > 0) {
    excludedSaCoilQty = roundSaQty(await sumApprovedAddCoilQtyForAdjustment(excludeId));
    coilUsedQty = Math.max(0, roundSaQty(coilUsedQty - excludedSaCoilQty));
  }
  const pendingSaAddQty = roundSaQty(await sumPendingAddQtyForMrn(uid, excludeAdjustmentId));
  const usedQty = roundSaQty(coilUsedQty + pendingSaAddQty);
  const remainingQty = Math.max(0, roundSaQty(receipt - usedQty));

  return {
    receipt_qty: receipt,
    coil_used_qty: coilUsedQty,
    excluded_sa_coil_qty: excludedSaCoilQty,
    pending_sa_add_qty: pendingSaAddQty,
    prior_add_qty: usedQty,
    remaining_qty: remainingQty,
  };
}
