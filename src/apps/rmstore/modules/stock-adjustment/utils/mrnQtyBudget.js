import { roundSaQty } from "./stockAdjustmentQty.js";
import { sumApprovedAddCoilQtyForAdjustment, sumCoilQtyForMrn } from "../../coil/models/coil.model.js";
import { sumPendingAddQtyForMrn } from "../models/stockAdjustment.model.js";
import { findMrnByUid } from "../../mrn/models/mrn.model.js";
import { fetchErpMrnByKey, fetchErpMrnOldByKey } from "../../mrn/utils/resolveMrnForSticker.js";
/** ERP Old-stock coil JSON — same qty list as FE `parseErpMrnCoils`. */
function parseErpMrnCoilsQtyList(erpRow) {
  let raw = erpRow?.coils ?? erpRow?.Coils ?? null;
  if (raw == null || raw === "") return [];
  if (typeof raw === "string") {
    for (const attempt of [
      raw,
      raw.replace(/(["']coil["']\s*:\s*)(\d+\/\d+)/gi, '$1"$2"'),
    ]) {
      try {
        let parsed = JSON.parse(attempt);
        if (typeof parsed === "string") parsed = JSON.parse(parsed);
        if (Array.isArray(parsed)) {
          return parsed
            .map((item) => roundSaQty(item?.qty ?? item?.Qty))
            .filter((q) => Number.isFinite(q) && q > 0);
        }
      } catch {
        /* try next */
      }
    }
    const qtys = [];
    const re = /"qty"\s*:\s*(\d+(?:\.\d+)?)/gi;
    let m;
    while ((m = re.exec(raw))) {
      const q = roundSaQty(m[1]);
      if (Number.isFinite(q) && q > 0) qtys.push(q);
    }
    return qtys;
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => roundSaQty(item?.qty ?? item?.Qty))
    .filter((q) => Number.isFinite(q) && q > 0);
}

function sumErpMrnCoilsQty(erpRow) {
  const qtys = parseErpMrnCoilsQtyList(erpRow);
  if (!qtys.length) return 0;
  return roundSaQty(qtys.reduce((s, q) => s + q, 0));
}

function erpLineReceiptCap(erpRow) {
  if (!erpRow) return 0;
  const receipt = roundSaQty(erpRow?.it_recp_qty);
  const coilSum = sumErpMrnCoilsQty(erpRow);
  const parts = [receipt, coilSum].filter((n) => Number.isFinite(n) && n > 0);
  return parts.length ? Math.max(...parts) : 0;
}

/**
 * MRN receipt cap per UID from IMS only — never above internal API line qty for that uid.
 * Prefer `mrn_rm_old` (itrecpqty + coils) when present; else `mrn_rm`. Less than cap is OK; more is blocked.
 * Local `rmstore_mrn` / FE hint / bill totalqty do not raise the cap above IMS.
 */
export async function resolveMrnReceiptQtyForBudget(
  mrn_uid,
  receiptQtyHint = null,
  { financialYear = null } = {}
) {
  const hint = roundSaQty(receiptQtyHint);
  const uid = String(mrn_uid || "").trim();
  if (!uid) {
    return Number.isFinite(hint) && hint > 0 ? hint : 0;
  }

  let erpTotalQty = 0;

  try {
    const oldCap = erpLineReceiptCap(await fetchErpMrnOldByKey(uid, { financialYear }));
    if (oldCap > 0) return oldCap;
  } catch {
    /* optional */
  }

  try {
    const erp = await fetchErpMrnByKey(uid);
    const liveCap = erpLineReceiptCap(erp);
    erpTotalQty = roundSaQty(erp?.totalqty ?? erp?.total_qty);
    if (liveCap > 0) return liveCap;
  } catch {
    /* optional */
  }

  let localQty = 0;
  try {
    localQty = roundSaQty((await findMrnByUid(uid))?.it_recp_qty);
  } catch {
    /* optional */
  }
  if (localQty > 0) return localQty;
  if (Number.isFinite(hint) && hint > 0) return hint;
  if (Number.isFinite(erpTotalQty) && erpTotalQty > 0) return erpTotalQty;
  return 0;
}

export async function resolveSaMrnReceiptCap(
  mrn_uid,
  { receiptQtyHint = null, financialYear = null } = {}
) {
  return resolveMrnReceiptQtyForBudget(mrn_uid, receiptQtyHint, { financialYear });
}

/**
 * MRN qty budget for Stock Adjustment Add (+) and MRN search:
 *   remaining = receipt − allocated coil qty (portal + approved SA, incl. partial consume) − pending SA Add
 * Approved SA qty lives in coil rows — not double-counted via adjustment sum.
 */
export async function computeMrnQtyBudget(
  mrn_uid,
  { receiptQty, excludeAdjustmentId = null, entryType = null, financialYear = null } = {}
) {
  const uid = String(mrn_uid || "").trim();
  const receipt = await resolveSaMrnReceiptCap(uid, {
    receiptQtyHint: receiptQty,
    entryType,
    financialYear,
  });
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
