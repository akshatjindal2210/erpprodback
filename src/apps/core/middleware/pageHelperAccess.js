import { accessControl } from "./accessControl.js";

/**
 * Core helpers — same contract as IMS helperAccess:
 * body.permission_module + permission_action must be allowed for this helper,
 * then user must have that module action (super_admin bypass).
 */
export function pageHelperAccess(resolveFields) {
  return (req, res, next) => {
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

    return accessControl(page, action)(req, res, next);
  };
}
