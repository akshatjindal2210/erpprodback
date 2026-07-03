import { isTaskVirtualModule } from "../../utils/userHelperAppFilter.js";

export function resolveDepartmentViewsSelectFields({ permission_module, permission_action } = {}) {
  const act = permission_action;
  if (!permission_module || !act) return null;
  if (!["view", "add", "edit", "authorize"].includes(act)) return null;
  if (permission_module === "departments" || isTaskVirtualModule(permission_module)) {
    return ["id", "name"];
  }
  return null;
}
