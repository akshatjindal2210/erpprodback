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

export function isSuperAdminUser(user) {
  return String(user?.type || user?.role || "").toLowerCase().trim() === "super_admin";
}

export function parseRmstoreSpecialPermissions(user) {
  return parseSpecialPermissions(user?.special_permissions)?.rmstore || {};
}

/** Can type spec header / line values freely (else dropdown-only). */
export function hasTypeSpecValuesPermission(user) {
  if (isSuperAdminUser(user)) return true;
  return Boolean(parseRmstoreSpecialPermissions(user)?.type_spec_values);
}

/** SP1 — Issue Request: pick any mapped RM for a job card item. */
export function hasIssueRmMappedPermission(user) {
  if (isSuperAdminUser(user)) return false;
  return parseRmstoreSpecialPermissions(user)?.issue_rm_mapped === true;
}

/** Submit in-process rejection (authorize permission still required to approve). */
export function hasInProcessRejectionPermission(user) {
  if (isSuperAdminUser(user)) return true;
  return Boolean(parseRmstoreSpecialPermissions(user)?.in_process_rejection);
}
