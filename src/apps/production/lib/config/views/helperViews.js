import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

/**
 * Production helper access (IMS / Engineering style).
 *
 * Rule: caller sends the PAGE they are on (`permission_module` + `permission_action`),
 * NOT the helper module name. Middleware checks:
 *   1) Is this page allowed to use this helper?
 *   2) Does the user have that page's action?
 */

const VIEW = "view";
const FORM = ["add", "edit", "authorize"];
const PICKER = [VIEW, ...FORM];

/**
 * /job-card/register-helper · get-helper · update-helper
 * Who can load / soft-update job cards without needing production_job_card.
 *
 * page module              | allowed actions
 * -------------------------|---------------------------
 * production_planning      | view, edit   (Job Card Board / Calendar)
 * production_job_card      | view, add, edit, authorize  (Maintain JC, if called via helper)
 */
const JOB_CARD_HELPER = {
  production_planning: [VIEW, "edit"],
  production_job_card: PICKER,
};

/** [] = allowed (access-only helpers). null = deny. */
function allowFromMap(accessMap, mod, act) {
  if (mod == null || act == null) return null;
  const actions = accessMap[mod];
  if (!actions) return null;
  return actions.includes(act) ? [] : null;
}

function fieldsForJobCard(mod, act) {
  return allowFromMap(JOB_CARD_HELPER, mod, act);
}

const BY_HELPER = {
  jobCard: fieldsForJobCard,
};

function resolveHelperFields(helper, { permission_module, permission_action } = {}) {
  const fn = BY_HELPER[helper];
  if (!fn) return null;
  return fn(permission_module, permission_action);
}

/** Controllers — same contract as Engineering resolveViewsFields */
export function resolveViewsFields(helper, perms = {}) {
  return resolveHelperFields(helper, perms);
}

/** Route middleware — helperAccess("jobCard") */
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
