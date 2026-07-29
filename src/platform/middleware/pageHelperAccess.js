import { accessControl } from "./accessControl.js";
import { NO_ACCESS_MESSAGE } from "../constants/messages.js";
import { isTaskVirtualModule, hasTaskAppRole } from "../utils/auth/userHelperAppFilter.js";

const TASK_MASTER_HELPERS = new Set(["departments", "designations"]);

/**
 * Core helpers — same contract as IMS helperAccess:
 * body.permission_module + permission_action must be allowed for this helper,
 * then user must have that module action (super_admin bypass).
 *
 * Task virtual modules (tasks, recurring_task, …) have no DB module row —
 * allowed when user has a task app role (same as task routes).
 */
export function pageHelperAccess(resolveFields) {
  return async (req, res, next) => {
    const page = req.body?.permission_module;
    const action = req.body?.permission_action;

    if (!page || !action) {
      return res.status(400).json({
        success: false,
        message: "permission_module and permission_action required in request body",
      });
    }

    const fields = resolveFields({ permission_module: page, permission_action: action });
    if (fields == null) {
      return res.status(403).json({
        success: false,
        message: "This helper is not allowed from this page",
      });
    }

    const userType = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
    if (userType === "super_admin") return next();

    if (isTaskVirtualModule(page)) {
      if (hasTaskAppRole(req.user)) {
        req.permission = {
          can_view: true,
          can_view_days: 0,
          can_add: true,
          can_edit: true,
          can_edit_days: 0,
          can_delete: false,
          can_authorize: false,
        };
        return next();
      }
      return res.status(403).json({ success: false, message: NO_ACCESS_MESSAGE });
    }

    if (TASK_MASTER_HELPERS.has(page) && hasTaskAppRole(req.user)) {
      req.permission = { can_view: true, can_view_days: 0 };
      return next();
    }

    return accessControl(page, action)(req, res, next);
  };
}
