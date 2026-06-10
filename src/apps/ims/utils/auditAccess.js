/** Assigned worker can access audit only inside scheduled dates (inclusive). */
export function isWithinAuditDateRange(audit, now = new Date()) {
  if (!audit?.start_date || !audit?.end_date) return false;
  const start = new Date(audit.start_date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(audit.end_date);
  end.setHours(23, 59, 59, 999);
  return now >= start && now <= end;
}

export function getAssignedLocationIds(audit, userId) {
  return (audit?.locations || [])
    .filter((loc) => loc?.is_active !== false && Number(loc?.assigned_user_id) === Number(userId))
    .map((loc) => Number(loc.location_id))
    .filter(Number.isFinite);
}

export function isUserAssignedOnAudit(audit, userId) {
  return (audit?.locations || []).some(
    (loc) => Number(loc?.assigned_user_id) === Number(userId)
  );
}

export function canManagementAccessAudit(permission = {}, user = {}) {
  if (user?.type === "super_admin") return true;
  return Boolean(permission.can_authorize || permission.can_edit || permission.can_view);
}

/** Workers with add-only access: assigned + active + within date window. */
export function canAssignedWorkerAccessAudit(audit, userId, now = new Date()) {
  if (!isUserAssignedOnAudit(audit, userId)) return false;
  if (!audit?.approved) return false;
  return isWithinAuditDateRange(audit, now);
}

export function canAccessAuditRecord(audit, user, permission = {}) {
  if (!audit) return false;
  if (canManagementAccessAudit(permission, user)) return true;
  if (Number(audit.created_by) === Number(user?.id)) return true;
  return canAssignedWorkerAccessAudit(audit, user?.id);
}

/** Creator / managers see location rows before audit is activated; assigned workers do not. */
export function canSeeInactiveAuditLocations(audit, user, permission = {}) {
  if (!audit || audit.approved) return true;
  if (user?.type === "super_admin") return true;
  if (permission.can_edit || permission.can_authorize) return true;
  return Number(audit.created_by) === Number(user?.id);
}

export function filterAuditLocationsForUser(audit, user, permission = {}) {
  if (!audit) return audit;
  if (canSeeInactiveAuditLocations(audit, user, permission)) return audit;
  return { ...audit, locations: [] };
}
