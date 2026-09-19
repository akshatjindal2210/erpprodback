/** MRN sticker scan-approved — explicit approval only. */
function isMrnStickerApproved(coil) {
  return coil?.sticker_approved === true;
}

function isSaAdjustmentApproved(coil) {
  if (coil?.sa_approved === true) return true;
  if (coil?.sa_approved === false) return false;
  return coil?.adjustment_approved === true;
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

/** QC status from joined qc_check row (or approved SA stock_in → passed). */
export function resolveCoilQcStatus(coil) {
  if (!coil) return "";
  if (coil.sa_id != null && isSaAdjustmentApproved(coil)) return "passed";
  return String(coil.qc_check_status || "").trim().toLowerCase();
}

/** Issue Request pool — active + QC passed. */
export function isCoilEligibleForIssueRequest(coil) {
  if (!coil) return false;
  const status = String(coil.status || "active").toLowerCase();
  if (status !== "active") return false;
  return resolveCoilQcStatus(coil) === "passed";
}
