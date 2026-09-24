import { accessControl } from "../../middleware/accessControl.js";
import { NO_ACCESS_MESSAGE } from "../../../../../platform/constants/messages.js";
import { isTaskVirtualModule, hasTaskAppRole } from "../../utils/auth/userHelperAppFilter.js";
import { resolveUserViewsSelectFields } from "./fields/user.js";

const okAction = (act) => act === "view" || act === "add" || act === "edit" || act === "authorize";

/** Which pages may call each helper (permission_module in POST body). */
const HELPERS = {
  attributes(mod, act) {
    return mod === "users" && okAction(act);
  },
  departments(mod, act) {
    return okAction(act) && (mod === "departments" || mod === "users" || isTaskVirtualModule(mod));
  },
  designations(mod, act) {
    return okAction(act) && (mod === "designations" || mod === "users" || isTaskVirtualModule(mod));
  },
  users(mod, act) {
    return resolveUserViewsSelectFields({ permission_module: mod, permission_action: act }) != null;
  },
};

/** Route middleware — helperAccess("attributes" | "departments" | "designations" | "users") */
export function helperAccess(name) {
  const allow = HELPERS[name];
  return (req, res, next) => {
    const mod = req.body?.permission_module;
    const act = req.body?.permission_action;

    if (!mod || !act) {
      return res.status(400).json({
        success: false,
        message: "permission_module and permission_action required in request body",
      });
    }

    if (!allow || !allow(mod, act)) {
      return res.status(403).json({
        success: false,
        message: "This helper is not allowed from this page",
      });
    }

    const userType = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
    if (userType === "super_admin") {
      return next();
    }

    if (isTaskVirtualModule(mod)) {
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

    if ((mod === "departments" || mod === "designations") && hasTaskAppRole(req.user)) {
      req.permission = { can_view: true, can_view_days: 0 };
      return next();
    }

    return accessControl(mod, act)(req, res, next);
  };
}
