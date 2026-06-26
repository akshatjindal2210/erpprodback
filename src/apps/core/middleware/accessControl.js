import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { getCachedPermissions, setCachedPermissions } from "../../../config/permissionCache.js";
import { findUserAppAccess } from "../models/permission.model.js";
import { moduleSortOrderNumericExpr } from "../utils/moduleSortOrderSql.js";

const MODULE_SORT_ORDER = moduleSortOrderNumericExpr("m");

import { MODULE_DISABLED_MESSAGE, NO_ACCESS_MESSAGE } from "../constants/messages.js";
import { APP_META } from "../../../config/portalModules.js";

export const accessControl = (moduleName, actions) => {
  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({ success: false, message: "Unauthorized user not found" });
      }

      // Super admin bypass
      const userType = String(user.type || user.role || "").toLowerCase().trim();
      if (userType === "super_admin") {
        // console.log("[AccessControl] Super Admin bypass triggered for user:", user.id);
        req.permission = {
          can_view: true,
          can_view_days: 0,
          can_add: true,
          can_edit: true,
          can_edit_days: 0,
          can_delete: true,
          can_authorize: true
        };
        return next();
      }

      if (!userType) {
         console.error("[AccessControl] User has no type/role:", user);
      }

      // Ensure actions is an array
      const actionList = Array.isArray(actions) ? actions : [actions];

      // Special case: app_configuration view is allowed for anyone with any app access (for shortcuts)
      if (moduleName === "app_configuration" && actionList.length === 1 && actionList[0] === "view") {
        const appAccess = await findUserAppAccess(user.id);
        const hasAnyAppAccess = Object.values(appAccess).some(val => !!val);
        if (hasAnyAppAccess) {
          req.permission = { can_view: true, can_view_days: 0 };
          return next();
        }
      }

      // Hard gate: module must be active right now.
      const [moduleRow] = await dbQuery(
        `SELECT is_active, app_type
         FROM ${M.MODULES}
         WHERE name = $1
         LIMIT 1`,
        [moduleName]
      );

      if (!moduleRow || moduleRow.is_active !== true) {
        return res.status(403).json({
          success: false,
          message: MODULE_DISABLED_MESSAGE
        });
      }

      // Try to get permissions from cache
      let permissions = getCachedPermissions(user.id);

      // If not in cache, fetch from DB
      if (!permissions) {
        const perms = await dbQuery(
          `SELECT up.can_view, up.can_view_days, up.can_add, up.can_edit, up.can_edit_days, up.can_delete, up.can_authorize, m.name as module_name, m.app_type as module_app_type, m.is_active as module_is_active
           FROM ${M.USER_PERMISSIONS} up
           JOIN ${M.MODULES} m ON m.id = up.module_id
           WHERE up.user_id = $1
             AND m.is_active = true
             AND up.is_deleted = false
           ORDER BY ${MODULE_SORT_ORDER} ASC, m.label ASC NULLS LAST, m.id ASC`,
          [user.id]
        );

        permissions = perms || [];
        setCachedPermissions(user.id, permissions); // Store in cache
      }

      // Find permissions for the requested module
      const modulePerm = permissions.find(p => p.module_name === moduleName);

      if (modulePerm) {
        if (modulePerm.module_is_active === false) {
          return res.status(403).json({
            success: false,
            message: MODULE_DISABLED_MESSAGE
          });
        }

        // Check allowed actions
        const isAllowed = actionList.some(action => modulePerm[`can_${action}`]);
        if (isAllowed) {
          // Attach permissions to request
          req.permission = modulePerm;
          return next();
        }
      }

      // --- Fallback: App Level Access ---
      // If granular permission check fails, check if user has access to the APP that this module belongs to.
      // For "view" actions on "core" modules (like users), we also allow if they have access to ANY other app (like task).
      const appAccess = await findUserAppAccess(user.id);
      const moduleAppType = moduleRow.app_type;

      // 1. Direct app access check — only when app has no granular module permissions
      if (appAccess[moduleAppType] && APP_META[moduleAppType]?.permissions === false) {
        if (actionList.length === 1 && actionList[0] === "view") {
          req.permission = { can_view: true, can_view_days: 0 };
          return next();
        }
      }

      // 2. Cross-app dependency check: 
      // If a user has access to Task or IMS, they likely need "view" access to core modules like "users", "departments", etc.
      if (moduleAppType === "core" && (actionList.length === 1 && actionList[0] === "view")) {
        const hasAnyAppAccess = Object.values(appAccess).some(val => !!val);
        if (hasAnyAppAccess) {
          req.permission = { can_view: true, can_view_days: 0 };
          return next();
        }
      }

      return res.status(403).json({ success: false, message: NO_ACCESS_MESSAGE });
    } catch (err) {
      console.error("accessControl error:", err);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  };
};

/**
 * Allow if the user satisfies ANY of the given { moduleName, actions } pairs.
 * Attaches `req.permission` from the first matching alternative (order matters).
 * @param {Array<{ moduleName: string, actions: string | string[] }>} alternatives
 */
export const accessControlAny = (alternatives) => {
  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({ success: false, message: "Unauthorized user not found" });
      }

      const userType = String(user.type || user.role || "").toLowerCase().trim();
      if (userType === "super_admin") {
        // console.log("[AccessControlAny] Super Admin bypass triggered for user:", user.id);
        req.permission = {
          can_view: true,
          can_view_days: 0,
          can_add: true,
          can_edit: true,
          can_edit_days: 0,
          can_delete: true,
          can_authorize: true
        };
        return next();
      }

      let permissions = getCachedPermissions(user.id);

      if (!permissions) {
        const perms = await dbQuery(
          `SELECT up.can_view, up.can_view_days, up.can_add, up.can_edit, up.can_edit_days, up.can_delete, up.can_authorize, m.name as module_name, m.app_type as module_app_type, m.is_active as module_is_active
           FROM ${M.USER_PERMISSIONS} up
           JOIN ${M.MODULES} m ON m.id = up.module_id
           WHERE up.user_id = $1
             AND m.is_active = true
             AND up.is_deleted = false
           ORDER BY ${MODULE_SORT_ORDER} ASC, m.label ASC NULLS LAST, m.id ASC`,
          [user.id]
        );

        if (!perms || perms.length === 0) {
          return res.status(403).json({ success: false, message: NO_ACCESS_MESSAGE });
        }

        permissions = perms;
        setCachedPermissions(user.id, permissions);
      }

      for (const alt of alternatives) {
        const { moduleName, actions } = alt;
        if (!moduleName) continue;

        const [moduleRow] = await dbQuery(
          `SELECT is_active, app_type FROM ${M.MODULES} WHERE name = $1 LIMIT 1`,
          [moduleName]
        );
        if (!moduleRow || moduleRow.is_active !== true) continue;

        const modulePerm = permissions.find((p) => p.module_name === moduleName);
        const actionList = Array.isArray(actions) ? actions : [actions];

        if (modulePerm && modulePerm.module_is_active !== false) {
          const isAllowed = actionList.some((action) => modulePerm[`can_${action}`]);
          if (isAllowed) {
            req.permission = modulePerm;
            return next();
          }
        }

        // Fallback: App Level Access for alternatives
        const appAccess = await findUserAppAccess(user.id);
        const moduleAppType = moduleRow.app_type;

        if (appAccess[moduleAppType] && APP_META[moduleAppType]?.permissions === false) {
          if (actionList.length === 1 && actionList[0] === "view") {
            req.permission = { can_view: true, can_view_days: 0 };
            return next();
          }
        }

        if (moduleAppType === "core" && (actionList.length === 1 && actionList[0] === "view")) {
          const hasAnyAppAccess = Object.values(appAccess).some(val => !!val);
          if (hasAnyAppAccess) {
            req.permission = { can_view: true, can_view_days: 0 };
            return next();
          }
        }
      }

      return res.status(403).json({
        success: false,
        message: NO_ACCESS_MESSAGE,
      });
    } catch (err) {
      console.error("accessControlAny error:", err);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  };
};

/** Body se permission_module + permission_action leke user ki page permission check karo. */
export const dynamicAccessControl = () => {
  return (req, res, next) => {
    const moduleName = req.body?.permission_module;
    const action = req.body?.permission_action;

    if (!moduleName || !action) {
      return res.status(400).json({
        success: false,
        message: "permission_module and permission_action required in request body",
      });
    }

    const user = req.user;
    if (user && String(user.type || user.role || "").toLowerCase().trim() === "super_admin") {
      return next();
    }

    accessControl(moduleName, action)(req, res, next);
  };
};

export const superAdminOnly = (req, res, next) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, message: "Unauthorized user not found" });
  }
  const userType = String(user.type || user.role || "").toLowerCase().trim();
  if (userType !== "super_admin") {
    return res.status(403).json({ success: false, message: "Only super admin can perform this action" });
  }
  next();
};
