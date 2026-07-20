import { SETTINGS_MODULES } from "../../../config/portalModules.js";

/** Task pages — no DB module row; access is role + app toggle (same as task routes). */
export const TASK_VIRTUAL_MODULES = new Set([
  "tasks",
  "cl_task_master",
  "cl_task",
  "cl_task_verification",
  "task_report",
  "red_ticket",
  "recurring_task",
]);

export const TASK_APP_ROLES = ["super_admin", "admin", "user", "executive_assistant"];

export function isTaskVirtualModule(name) {
  return TASK_VIRTUAL_MODULES.has(String(name || "").toLowerCase().trim());
}

export function hasTaskAppRole(user) {
  const role = String(user?.type || user?.role || "").toLowerCase().trim();
  return TASK_APP_ROLES.includes(role);
}

/** Which app bucket to filter user pickers by (null = no filter). */
export function resolveUserHelperAppKey(permissionModule, moduleAppType) {
  const mod = String(permissionModule || "").toLowerCase().trim();
  if (!mod) return null;
  if (mod === "users" || SETTINGS_MODULES.includes(mod)) return null;
  if (TASK_VIRTUAL_MODULES.has(mod)) return "task";
  const appType = String(moduleAppType || "").toLowerCase().trim();
  if (appType === "ims" || appType === "task") return appType;
  return null;
}
