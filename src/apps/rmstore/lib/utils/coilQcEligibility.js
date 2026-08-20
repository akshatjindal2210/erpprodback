/** QC is only for coils created from MRN Portal stickers — not Stock Adjustment Add or IPR returns. */
export function isCoilEligibleForQc(coil) {
  if (!coil) return false;
  const entryType = String(coil.sa_entry_type || "").toLowerCase();
  if (coil.sa_id != null && entryType === "stock_in") return false;
  if (entryType === "production_return") return false;
  if (!String(coil.mrn_uid || "").trim()) return false;
  if (coil.sticker_generated === false) return false;
  return true;
}

export const QC_ONLY_MRN_COIL_MESSAGE = "QC applies only to MRN Portal sticker coils (not Stock Adjustment or production-return stock).";

/** QC status from joined qc_check row (or SA stock_in → passed). */
export function resolveCoilQcStatus(coil) {
  if (!coil) return "";
  if (coil.sa_id != null) return "passed";
  return String(coil.qc_check_status || "").trim().toLowerCase();
}

/** Issue Request pool — active + QC passed. */
export function isCoilEligibleForIssueRequest(coil) {
  if (!coil) return false;
  const status = String(coil.status || "active").toLowerCase();
  if (status !== "active") return false;
  return resolveCoilQcStatus(coil) === "passed";
}
