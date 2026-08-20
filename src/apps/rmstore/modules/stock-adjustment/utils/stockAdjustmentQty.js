/** Per-coil qty parsing / auto-split for Stock Adjustment Add (same rules as MRN stickers). */

import { roundCoilQty, splitQtyAcrossCoils, equalSplitQtyAcrossCoils } from "../../../lib/utils/coilQtySplit.js";

export const QTY_EPS = 0.001;

export const roundSaQty = roundCoilQty;
export { splitQtyAcrossCoils, equalSplitQtyAcrossCoils };

export function parseCoilQtys(body, coilCount) {
  let raw = body?.coil_qtys ?? body?.coils ?? null;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw) || raw.length !== coilCount) return null;
  const qtys = raw.map((c) => {
    if (c != null && typeof c === "object") return Number(c.qty);
    return Number(c);
  });
  if (qtys.some((q) => !Number.isFinite(q) || q < 0)) return null;
  return qtys.map((q) => roundSaQty(q));
}

export function parseStoredCoilQtys(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw.map((q) => roundSaQty(q));
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((q) => roundSaQty(q));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Resolve per-coil qtys for Add adjustment.
 * Prefers explicit coil_qtys; falls back to uniform per_coil_qty; else auto-split total.
 */
export function resolveAddCoilQtys(body, coilCount, { qtyAutoCalc = true, qtyEditable = true } = {}) {
  const n = Math.max(1, parseInt(String(coilCount), 10) || 1);
  const receiptQty = roundSaQty(body?.it_recp_qty ?? body?.mrn_receipt_qty);
  const bodyTotal = roundSaQty(body?.qty ?? body?.total_qty);
  /** Prefer entered adjustment qty; MRN receipt is the ceiling reference only. */
  const originalQty =
    Number.isFinite(bodyTotal) && bodyTotal > 0
      ? bodyTotal
      : Number.isFinite(receiptQty) && receiptQty > 0
        ? receiptQty
        : null;

  if (!qtyEditable) {
    if (!Number.isFinite(originalQty) || originalQty <= 0) return null;
    return qtyAutoCalc
      ? splitQtyAcrossCoils(originalQty, n)
      : equalSplitQtyAcrossCoils(originalQty, n);
  }

  if (!qtyAutoCalc) {
    return parseCoilQtys(body, n);
  }

  const parsed = parseCoilQtys(body, n);
  if (parsed) return parsed;

  const per = Number(body?.per_coil_qty);
  if (Number.isFinite(per) && per > 0) {
    return Array.from({ length: n }, () => roundSaQty(per));
  }

  if (!Number.isFinite(originalQty) || originalQty <= 0) return null;

  return qtyAutoCalc
    ? splitQtyAcrossCoils(originalQty, n)
    : equalSplitQtyAcrossCoils(originalQty, n);
}

export function assertCoilQtysMatchTotal(coilQtys, totalQty) {
  const sum = coilQtys.reduce((s, q) => s + roundSaQty(q), 0);
  const target = roundSaQty(totalQty);
  if (Math.abs(sum - target) > QTY_EPS) {
    const err = new Error(
      `Coil quantities must add up to ${target.toLocaleString()} (current total: ${sum.toLocaleString()}).`
    );
    err.statusCode = 400;
    throw err;
  }
  return coilQtys;
}
