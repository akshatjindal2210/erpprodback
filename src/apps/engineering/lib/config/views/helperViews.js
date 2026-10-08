import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

/**
 * Engineering helper access (IMS style).
 *
 * Rule: caller sends the PAGE they are on (`permission_module` + `permission_action`),
 * NOT the helper module name. Middleware checks:
 *   1) Is this page allowed to use this helper?
 *   2) Does the user have that page's action?
 *
 * To allow a new screen to pick processes, add one line under the helper map below.
 */

const VIEW = "view";
const FORM = ["add", "edit", "authorize"];
const PICKER = [VIEW, ...FORM]; // list + form modes

/**
 * /process-master/helper
 * Who can load process dropdown (without needing eng_process_master.view).
 *
 * page module              | allowed actions
 * -------------------------|---------------------------
 * eng_machine_master       | view, add, edit, authorize
 * eng_process_master       | view, add, edit, authorize  (parent picker)
 */
const PROCESS_MASTER_HELPER = {
  eng_machine_master: PICKER,
  eng_process_master: PICKER,
};

/** [] = allowed (access-only helpers; no SQL field lists yet). null = deny. */
function allowFromMap(accessMap, mod, act) {
  if (mod == null || act == null) return null;
  const actions = accessMap[mod];
  if (!actions) return null;
  return actions.includes(act) ? [] : null;
}

function fieldsForProcessMaster(mod, act) {
  return allowFromMap(PROCESS_MASTER_HELPER, mod, act);
}

const BY_HELPER = {
  processMaster: fieldsForProcessMaster,
};

function resolveHelperFields(helper, { permission_module, permission_action } = {}) {
  const fn = BY_HELPER[helper];
  if (!fn) return null;
  return fn(permission_module, permission_action);
}

/** Controllers — same contract as IMS resolveViewsFields */
export function resolveViewsFields(helper, perms = {}) {
  return resolveHelperFields(helper, perms);
}

/** Route middleware — helperAccess("processMaster") */
export function helperAccess(helper) {
  return (req, res, next) => {
    const page = req.body?.permission_module;
    const action = req.body?.permission_action;

    if (!page || !action) {
      return res.status(400).json({
        success: false,
        message: "permission_module and permission_action required in request body",
      });
    }

    if (resolveHelperFields(helper, { permission_module: page, permission_action: action }) == null) {
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
