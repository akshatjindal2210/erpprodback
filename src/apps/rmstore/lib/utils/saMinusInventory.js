/** Shop floor = issued via Store Out (has out_uid). */
export function isIssuedToShopFloor(coil) {
  const status = String(coil?.status || "active").toLowerCase();
  const issued = coil?.out_uid != null && String(coil.out_uid).trim() !== "";
  return status === "out" && issued;
}

/**
 * SA Minus write-off — coil is adjusted out of inventory, not returned to shop floor.
 * Includes legacy rows that used status=out with sa_entry_type=stock_out and no out_uid.
 */
export function isSaMinusWriteOff(coil) {
  const saType = String(coil?.sa_entry_type || "").trim().toLowerCase();
  if (saType !== "stock_out") return false;
  const issued = coil?.out_uid != null && String(coil.out_uid).trim() !== "";
  return !issued;
}

/**
 * Coil can be chosen on a Minus save/update.
 * Active store coils are allowed. Coils already written off on this same
 * adjustment are allowed so approved Minus records can be edited.
 */
export function isCoilAvailableForSaMinus(coil, { excludeAdjustmentId = null } = {}) {
  if (!coil) return false;
  if (isIssuedToShopFloor(coil)) return false;

  const excludeId = Number(excludeAdjustmentId);
  const sameAdj =
    Number.isFinite(excludeId) &&
    excludeId > 0 &&
    coil.sa_id != null &&
    Number(coil.sa_id) === excludeId &&
    isSaMinusWriteOff(coil);
  if (sameAdj) return true;

  const status = String(coil.status || "active").toLowerCase();
  if (status !== "active") return false;
  if (isSaMinusWriteOff(coil)) return false;
  return true;
}

