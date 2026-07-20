/**
 * Portal View days / Edit days (0 = unlimited).
 * Aligns with IMS can_view_days / can_edit_days checks.
 */

export function isSuperAdminReq(req) {
  const t = String(req?.user?.type || req?.user?.role || "").toLowerCase().trim();
  return t === "super_admin";
}

export function permissionDiffDaysFromDate(createdAt) {
  if (!createdAt) return null;
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return null;
  return Math.ceil(Math.abs(Date.now() - at.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * @returns {{ status: number, message: string } | null} error payload or null if allowed
 */
export function assertWithinEditDays(req, createdAt, label = "edit") {
  if (isSuperAdminReq(req)) return null;
  const days = Number(req.permission?.can_edit_days) || 0;
  if (days <= 0) return null;
  const diff = permissionDiffDaysFromDate(createdAt);
  if (diff == null) return null;
  if (diff > days) {
    return {
      status: 403,
      message: `Edit time limit exceeded. You can only ${label} records from the last ${days} day(s).`,
    };
  }
  return null;
}

/** SQL fragment helper: created_at within can_view_days (caller binds viewDays). */
export function viewDaysSqlClause(columnSql = "created_at") {
  return `${columnSql}::date >= CURRENT_DATE - (?::int - 1)`;
}
