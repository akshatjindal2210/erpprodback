/** MRN sticker scan-approved — explicit approval only. */
function isMrnStickerApproved(coil) {
  return coil?.sticker_approved === true;
}

function isSaAdjustmentApproved(coil) {
  if (coil?.sa_approved === true) return true;
  if (coil?.sa_approved === false) return false;
  return coil?.adjustment_approved === true;
}

function isSaStockInCoil(coil) {
  return coil?.sa_id != null && String(coil?.sa_entry_type || "").toLowerCase() === "stock_in";
}

function isMrnPortalCoil(coil) {
  const entryType = String(coil?.sa_entry_type || "").toLowerCase();
  if (coil?.sa_id != null) return false;
  if (entryType === "production_return") return false;
  return Boolean(String(coil?.mrn_uid || "").trim());
}

/** QC is only for MRN Portal sticker coils with approved stickers (Store In not required). */
export function isCoilEligibleForQc(coil) {
  if (!coil) return false;
  const entryType = String(coil.sa_entry_type || "").toLowerCase();
  if (coil.sa_id != null && entryType === "stock_in") return false;
  if (entryType === "production_return") return false;
  if (!String(coil.mrn_uid || "").trim()) return false;
  if (coil.sticker_generated === false) return false;
  if (!isMrnStickerApproved(coil)) return false;
  return true;
}

export function qcCoilIneligibilityMessage(coil) {
  if (!coil) return "Coil not found.";
  const entryType = String(coil.sa_entry_type || "").toLowerCase();
  if (coil.sa_id != null && entryType === "stock_in") {
    return "QC is not for Stock Adjustment coils.";
  }
  if (entryType === "production_return") {
    return "QC is not for production-return coils.";
  }
  if (!String(coil.mrn_uid || "").trim() || coil.sticker_generated === false) {
    return "QC is only for MRN Portal coils.";
  }
  if (!isMrnStickerApproved(coil)) {
    return "Approve stickers in MRN Portal first.";
  }
  return "This coil is not ready for QC.";
}

/**
 * Issuable flag on coil reads — MRN: QC Check module status.
 * SA Add: authorized adjustment only (SQL `passed`; not QC Check).
 */
export function resolveCoilQcStatus(coil) {
  if (!coil) return "";
  if (isSaStockInCoil(coil) && isSaAdjustmentApproved(coil)) return "passed";
  return String(coil.qc_check_status || "").trim().toLowerCase();
}

/** Issue / Store Out. Pending entry → Store In only. SA Add → authorize. MRN → sticker approve + QC Check. */
export function isCoilEligibleForIssueRequest(coil) {
  if (!coil) return false;
  const status = String(coil.status || "active").toLowerCase();
  if (status !== "active") return false;
  if (isSaStockInCoil(coil)) {
    return resolveCoilQcStatus(coil) === "passed";
  }
  if (isMrnPortalCoil(coil) && !isMrnStickerApproved(coil)) return false;
  return resolveCoilQcStatus(coil) === "passed";
}
