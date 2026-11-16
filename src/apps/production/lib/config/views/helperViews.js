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
const isForm = (act) => FORM.includes(act);

const locPicker = [
  "lm.location_id",
  "lm.location_id AS id",
  "lm.rack_no",
  "lm.shelf_no AS row_no",
  "lm.proccode",
  `NULLIF(UPPER(BTRIM(split_part(COALESCE(lm.location_no::text, ''), '_', 1))), '') AS process_tag`,
  "pr.procname AS process_name",
  "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no",
  "lm.type",
  "lm.total_capacity",
  "(COALESCE((SELECT COUNT(*)::int FROM ims_box_table b WHERE b.location_id = lm.location_id AND b.is_deleted = false AND (b.out_uid IS NULL OR NULLIF(TRIM(b.out_uid::text), '') IS NULL) AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')), 0) + COALESCE((SELECT COUNT(*)::int FROM rmstore_coil_table rc WHERE rc.location_id = lm.location_id AND COALESCE(rc.status, 'active') IN ('active', 'rejected')), 0)) AS occupied_capacity",
  "GREATEST(COALESCE(lm.total_capacity, 0) - (COALESCE((SELECT COUNT(*)::int FROM ims_box_table b WHERE b.location_id = lm.location_id AND b.is_deleted = false AND (b.out_uid IS NULL OR NULLIF(TRIM(b.out_uid::text), '') IS NULL) AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')), 0) + COALESCE((SELECT COUNT(*)::int FROM rmstore_coil_table rc WHERE rc.location_id = lm.location_id AND COALESCE(rc.status, 'active') IN ('active', 'rejected')), 0)), 0) AS available_capacity",
];
const locModal = [
  ...locPicker,
  "lm.location_description",
  "COALESCE(lm.item_dcodes, '{}') AS item_dcodes",
  "(COALESCE(lm.item_dcodes, '{}'))[1] AS item_dcode",
  "NULL::text AS item_code",
  "NULL::text AS item_desc",
];

function fieldsForLocations(mod, act) {
  if (mod == null || act == null) return null;
  if (mod === "production_location_master" && act === VIEW) return [...locPicker];
  if (mod === "production_location_master" && isForm(act)) return [...locModal];
  if (mod === "production_bin_manage" && (act === VIEW || isForm(act))) return [...locPicker];
  return null;
}

/**
 * /jc/register-helper · get-helper · update-helper
 * Who can load / soft-update job cards without needing production_job_card.
 *
 * page module              | allowed actions
 * -------------------------|---------------------------
 * production_planning      | view, edit   (Job Card Board / Calendar)
 * production_job_card      | view, add, edit, authorize  (Maintain JC, if called via helper)
 * production_entry         | view, add, edit, authorize  (Production Entry form)
 */
const JOB_CARD_HELPER = {
  production_planning: [VIEW, "edit"],
  production_job_card: PICKER,
  production_entry: PICKER,
  production_bin_manage: PICKER,
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

const binPicker = ["t.id", "t.code", "t.type", "t.serial_number", "t.batch_id", "t.weight"];

function fieldsForBins(mod, act) {
  if (mod == null || act == null) return null;
  if (mod === "production_bin_master" && (act === VIEW || isForm(act))) return [...binPicker];
  if (mod === "production_bin_manage" && (act === VIEW || isForm(act))) return [...binPicker];
  return null;
}

const BY_HELPER = {
  jobCard: fieldsForJobCard,
  locations: fieldsForLocations,
  bins: fieldsForBins,
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
