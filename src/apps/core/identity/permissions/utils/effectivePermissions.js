/**
 * Merge direct user permissions with assigned attribute permissions (OR on flags).
 * Attribute grants remain effective even when they are not copied onto the user record.
 */
import { PORTAL_APP_KEYS } from "../../../../../config/portal/portalModules.js";

const BOOL_KEYS = ["can_view", "can_add", "can_edit", "can_delete", "can_authorize"];

/** 0 = unlimited; when either side is unlimited and allowed, keep 0; else take max. */
function mergeDays(aAllowed, aDays, bAllowed, bDays) {
  const a = aAllowed ? Number(aDays) || 0 : null;
  const b = bAllowed ? Number(bDays) || 0 : null;
  if (a == null) return b ?? 0;
  if (b == null) return a;
  if (a === 0 || b === 0) return 0;
  return Math.max(a, b);
}

/**
 * Merge permission row lists by module_id (OR for flags; max/unlimited for days).
 * @param {...Array<object>} lists
 * @returns {Array<object>}
 */
export function mergePermissionLists(...lists) {
  const byModule = new Map();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || row.module_id == null) continue;
      const id = Number(row.module_id);
      if (!Number.isFinite(id)) continue;

      const existing = byModule.get(id);
      if (!existing) {
        byModule.set(id, {
          module_id: id,
          module_name: row.module_name,
          module_label: row.module_label,
          module_app_type: row.module_app_type,
          module_is_active: row.module_is_active,
          can_view: !!row.can_view,
          can_view_days: Number(row.can_view_days) || 0,
          can_add: !!row.can_add,
          can_edit: !!row.can_edit,
          can_edit_days: Number(row.can_edit_days) || 0,
          can_delete: !!row.can_delete,
          can_authorize: !!row.can_authorize,
        });
        continue;
      }

      const next = { ...existing };
      for (const key of BOOL_KEYS) {
        next[key] = !!existing[key] || !!row[key];
      }
      next.can_view_days = mergeDays(existing.can_view, existing.can_view_days, row.can_view, row.can_view_days);
      next.can_edit_days = mergeDays(existing.can_edit, existing.can_edit_days, row.can_edit, row.can_edit_days);
      if (!next.module_name && row.module_name) next.module_name = row.module_name;
      if (!next.module_label && row.module_label) next.module_label = row.module_label;
      if (!next.module_app_type && row.module_app_type) next.module_app_type = row.module_app_type;
      if (next.module_is_active == null && row.module_is_active != null) {
        next.module_is_active = row.module_is_active;
      }
      byModule.set(id, next);
    }
  }

  return [...byModule.values()];
}

/**
 * Normalize attribute `permissions` JSON (map or array) → array of module rows.
 * Keeps only rows with at least one action enabled.
 */
export function normalizeAttributePermissions(raw) {
  if (raw == null) return [];

  let entries = [];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === "object") {
    entries = Object.entries(raw).map(([moduleId, perms]) => ({
      module_id: Number(moduleId),
      ...(perms && typeof perms === "object" ? perms : {}),
    }));
  } else {
    return [];
  }

  const out = [];
  for (const row of entries) {
    const module_id = Number(row?.module_id);
    if (!Number.isFinite(module_id) || module_id <= 0) continue;
    const normalized = {
      module_id,
      can_view: !!row.can_view,
      can_view_days: Number(row.can_view_days) || 0,
      can_add: !!row.can_add,
      can_edit: !!row.can_edit,
      can_edit_days: Number(row.can_edit_days) || 0,
      can_delete: !!row.can_delete,
      can_authorize: !!row.can_authorize,
    };
    if (!BOOL_KEYS.some((k) => normalized[k])) continue;
    out.push(normalized);
  }
  return out;
}

/**
 * Session / launcher app_access map.
 * - Explicit Allow-access OFF stays OFF (module perms must not turn the app back on).
 * - Apps with no stored toggle still infer ON from module can_view (legacy).
 * - No stored rows at all → fully infer from modules.
 */
export function mergeAppAccessWithPermissions(storedAppAccess = {}, permissions = []) {
  const stored = storedAppAccess || {};
  const inferred = Object.fromEntries(PORTAL_APP_KEYS.map((k) => [k, false]));
  for (const row of permissions) {
    if (!row?.can_view) continue;
    const app = String(row.module_app_type || "").trim().toLowerCase();
    if (PORTAL_APP_KEYS.includes(app)) inferred[app] = true;
  }

  if (Object.keys(stored).length === 0) return inferred;

  const out = Object.fromEntries(PORTAL_APP_KEYS.map((k) => [k, false]));
  for (const key of PORTAL_APP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) {
      out[key] = stored[key] === true;
    } else {
      out[key] = inferred[key] === true;
    }
  }
  return out;
}
