import dbQuery from "../config/db.js";
import { getCachedPermissions, setCachedPermissions } from "../config/permissionCache.js";
import { moduleSortOrderNumericExpr } from "../utils/moduleSortOrderSql.js";

const MODULE_SORT_ORDER = moduleSortOrderNumericExpr("m");

import { MODULE_DISABLED_MESSAGE, NO_ACCESS_MESSAGE } from "../global/messages.js";

export const accessControl = (moduleName, actions) => {
  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({ success: false, message: "Unauthorized — user not found" });
      }

      // Super admin bypass
      if (user.type === "super_admin") {
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

      // Ensure actions is an array
      const actionList = Array.isArray(actions) ? actions : [actions];

      // Hard gate: module must be active right now.
      // This check is DB-backed on every request so manual DB flips
      // (outside toggle endpoint/cache invalidation flow) are enforced instantly.
      const [moduleRow] = await dbQuery(
        `SELECT is_active
         FROM modules
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
          `SELECT up.can_view, up.can_view_days, up.can_add, up.can_edit, up.can_edit_days, up.can_delete, up.can_authorize, m.name as module_name, m.is_active as module_is_active
           FROM user_permissions up
           JOIN modules m ON m.id = up.module_id
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
        setCachedPermissions(user.id, permissions); // Store in cache
      }

      // Find permissions for the requested module
      const modulePerm = permissions.find(p => p.module_name === moduleName);

      if (!modulePerm) {
        return res.status(403).json({ success: false, message: NO_ACCESS_MESSAGE });
      }
      if (modulePerm.module_is_active === false) {
        return res.status(403).json({
          success: false,
          message: MODULE_DISABLED_MESSAGE
        });
      }

      // Check allowed actions
      const isAllowed = actionList.some(action => modulePerm[`can_${action}`]);
      if (!isAllowed) {
        return res.status(403).json({ success: false, message: NO_ACCESS_MESSAGE });
      }

      // Attach permissions to request
      req.permission = modulePerm;

      next();
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
        return res.status(401).json({ success: false, message: "Unauthorized — user not found" });
      }

      if (user.type === "super_admin") {
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
          `SELECT up.can_view, up.can_view_days, up.can_add, up.can_edit, up.can_edit_days, up.can_delete, up.can_authorize, m.name as module_name, m.is_active as module_is_active
           FROM user_permissions up
           JOIN modules m ON m.id = up.module_id
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
          `SELECT is_active FROM modules WHERE name = $1 LIMIT 1`,
          [moduleName]
        );
        if (!moduleRow || moduleRow.is_active !== true) continue;

        const modulePerm = permissions.find((p) => p.module_name === moduleName);
        if (!modulePerm || modulePerm.module_is_active === false) continue;

        const actionList = Array.isArray(actions) ? actions : [actions];
        const isAllowed = actionList.some((action) => modulePerm[`can_${action}`]);
        if (!isAllowed) continue;

        req.permission = modulePerm;
        return next();
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

export const dynamicAccessControl = () => {
  return (req, res, next) => {
    const moduleName = req.body?.permission_module;
    const action     = req.body?.permission_action;

    if (!moduleName || !action) {
      return res.status(400).json({
        success: false,
        message: "permission_module and permission_action required in request body"
      });
    }

    accessControl(moduleName, action)(req, res, next);
  };
};