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
