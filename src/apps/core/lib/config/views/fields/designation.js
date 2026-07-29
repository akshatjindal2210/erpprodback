import { isTaskVirtualModule } from "../../../utils/auth/userHelperAppFilter.js";

export function resolveDesignationViewsSelectFields({ permission_module, permission_action } = {}) {
  const act = permission_action;
  if (!permission_module || !act) return null;
  if (!["view", "add", "edit", "authorize"].includes(act)) return null;
  if (permission_module === "designations" || permission_module === "users" || isTaskVirtualModule(permission_module)) {
    return ["id", "name"];
  }
  return null;
}
