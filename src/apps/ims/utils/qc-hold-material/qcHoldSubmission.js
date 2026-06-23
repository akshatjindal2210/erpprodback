/**
 * QC Hold submission rules — qty checks and status normalization.
 */

import {
  QC_HOLD_MSG,
  qcHoldCombinedExceedsBalance,
  qcHoldCompletedExceedsBalance,
  qcHoldFullSubmitMustUseBalance,
  qcHoldRejectedExceedsBalance,
} from "../../constants/qcHoldMaterial.messages.js";
import { QC_HOLD_PARTIAL_ENABLED } from "../../constants/qcHoldFeatureFlags.js";

export const VALID_QC_HOLD_STATUS = new Set(["pending", "partial", "complete"]);
export const VALID_SUBMISSION_TYPES = new Set(["partial", "full", "revert"]);

/** When partial is off, only full + revert submissions are allowed for new API calls. */
export function normalizeSubmissionType(type) {
  const t = String(type ?? "").trim().toLowerCase();
  if (t === "revert") return "revert";
  if (!QC_HOLD_PARTIAL_ENABLED) return "full";
  return VALID_SUBMISSION_TYPES.has(t) ? t : "";
}

export function normalizeQcHoldStatus(value, fallback = "pending") {
  const s = String(value ?? fallback).trim().toLowerCase();
  return VALID_QC_HOLD_STATUS.has(s) ? s : fallback;
}

export function validateSubmissionQuantities({ type, balanceQty, completedQty, rejectedQty }) {
  if (completedQty <= 0 && rejectedQty <= 0) {
    return QC_HOLD_MSG.ENTER_COMPLETED_QTY;
  }
  if (completedQty > balanceQty) {
    return qcHoldCompletedExceedsBalance(completedQty, balanceQty);
  }
  if (rejectedQty > balanceQty) {
    return qcHoldRejectedExceedsBalance(rejectedQty, balanceQty);
  }

  const totalOutQty = completedQty + rejectedQty;
  if (totalOutQty > balanceQty) {
    return qcHoldCombinedExceedsBalance(totalOutQty, balanceQty);
  }

  if (type === "partial") {
    if (rejectedQty > 0) return QC_HOLD_MSG.REJECTED_ONLY_ON_FINAL;
    if (completedQty <= 0) return QC_HOLD_MSG.ENTER_COMPLETED_FOR_APPROVAL;
  }

  if (type === "revert") {
    if (rejectedQty > 0) return QC_HOLD_MSG.REVERT_NO_REJECT;
    if (completedQty !== balanceQty) return QC_HOLD_MSG.REVERT_MUST_USE_FULL_BALANCE;
    return null;
  }

  if (type === "full") {
    if (totalOutQty !== balanceQty) {
      return qcHoldFullSubmitMustUseBalance(balanceQty);
    }
  }

  return null;
}
