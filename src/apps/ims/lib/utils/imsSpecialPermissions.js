function parseSpecialPermissions(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

function isSuperAdminUser(user) {
  return String(user?.type || user?.role || "").toLowerCase().trim() === "super_admin";
}

export function hasInventoryOutPermission(user) {
  if (isSuperAdminUser(user)) return true;
  const perms = parseSpecialPermissions(user?.special_permissions);
  return Boolean(perms?.ims?.inventory_out);
}

export function hasInventoryOutApprovePermission(user) {
  if (isSuperAdminUser(user)) return true;
  const perms = parseSpecialPermissions(user?.special_permissions);
  return Boolean(perms?.ims?.inventory_approve);
}

/** Direct FN create without schedule (schno). Schedule-based create does not need this. */
export function hasDirectForwardingNotePermission(user) {
  if (isSuperAdminUser(user)) return true;
  const perms = parseSpecialPermissions(user?.special_permissions);
  return Boolean(perms?.ims?.direct_forwarding_note);
}

/** Attach item-wise bill on forwarding note (super_admin always). Update also needs edit. */
export function hasManageForwardingBillPermission(user) {
  if (isSuperAdminUser(user)) return true;
  const perms = parseSpecialPermissions(user?.special_permissions);
  return Boolean(perms?.ims?.manage_forwarding_bill);
}

/**
 * Packing sticker Deviation when monthly qty exceeds requirement.
 * Super Admin always; others need special_permissions.ims.packing_deviation.
 * (override_stock_shortage kept as alias for older grants.)
 */
export function canOverrideStockShortage(user) {
  if (isSuperAdminUser(user)) return true;
  const perms = parseSpecialPermissions(user?.special_permissions);
  return Boolean(perms?.ims?.packing_deviation || perms?.ims?.override_stock_shortage);
}

/** Alias — same check as canOverrideStockShortage. */
export function canCreatePackingDeviation(user) {
  return canOverrideStockShortage(user);
}
