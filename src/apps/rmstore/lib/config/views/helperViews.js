import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const VIEW = "view";
const FORM_ACTIONS = ["add", "edit", "authorize"];
const isForm = (act) => FORM_ACTIONS.includes(act);

const locPicker = [
  "lm.location_id",
  "lm.location_id AS id",
  "lm.rack_no",
  "lm.row_no",
  "COALESCE(lm.location_no, CONCAT('RM-', lm.rack_no, UPPER(COALESCE(lm.row_no, '')))) AS location_no",
];
const locModal = [
  ...locPicker,
  "lm.location_description",
  "lm.total_capacity",
  "lm.item_dcode",
  "lm.item_code",
  "lm.item_desc",
];

function fieldsForLocations(mod, act) {
  if (mod == null || act == null) return null;
  if (mod === "rm_store_location_master" && act === VIEW) return [...locPicker];
  if (mod === "rm_store_location_master" && isForm(act)) return [...locModal];
  // Store-In + Coil Finder need location nos
  if ((mod === "rm_inventory_inwards" || mod === "rm_coils") && (act === VIEW || isForm(act))) {
    return [...locPicker];
  }
  return null;
}

/** ERP dropdown helpers — [] means allowed (no SQL field list). */
function allowErpHelper(mod, act) {
  if (mod == null || act == null) return null;
  if (
    (mod === "rm_production_master" ||
      mod === "rm_spec_master" ||
      mod === "rm_store_location_master" ||
      mod === "rm_issue_request" ||
      mod === "rm_in_process_request" ||
      mod === "rm_stock_adjustment") &&
    (act === VIEW || isForm(act))
  ) {
    return [];
  }
  return null;
}

/** Coil table helper — verify coils from pages that lack rm_coils module access. */
function fieldsForCoils(mod, act) {
  if (mod == null || act == null) return null;
  const allowedModules = [
    "rm_coils",
    "rm_inventory_inwards",
    "rm_issue_request",
    "rm_in_process_request",
    "rm_stock_adjustment",
    "rm_qc_check",
    "rm_out_entry",
    "rm_mrn_portal",
    "rm_store_location_master",
    "rm_rejection",
    "rm_coil_transaction_logs",
    "rm_coil_download_logs",
    "rm_inventory_report",
  ];
  if (allowedModules.includes(mod) && (act === VIEW || isForm(act))) {
    return [];
  }
  return null;
}

function fieldsForQcCheck(mod, act) {
  if (mod == null || act == null) return null;
  if (mod === "rm_rejection" && (act === VIEW || isForm(act))) {
    return [];
  }
  return null;
}

function fieldsForIssueRequest(mod, act) {
  if (mod == null || act == null) return null;
  if (mod === "rm_rejection" && (act === VIEW || isForm(act))) {
    return [];
  }
  return null;
}

function fieldsForinProcessRequest(mod, act) {
  if (mod == null || act == null) return null;
  const allowed = ["rm_rejection", "rm_coils", "rm_qc_check", "rm_in_process_request"];
  if (allowed.includes(mod) && (act === VIEW || isForm(act))) {
    return [];
  }
  return null;
}

const BY_HELPER = {
  locations: fieldsForLocations,
  productionItems: allowErpHelper,
  rmItems: allowErpHelper,
  prdRunJc: allowErpHelper,
  coils: fieldsForCoils,
  qcCheck: fieldsForQcCheck,
  issueRequest: fieldsForIssueRequest,
  inProcessRequest: fieldsForinProcessRequest,
};

function resolveHelperFields(helper, { permission_module, permission_action } = {}) {
  const fn = BY_HELPER[helper];
  if (!fn) return null;
  return fn(permission_module, permission_action);
}

/** Route middleware — helperAccess("locations" | "productionItems" | "rmItems" | "coils") */
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

export function resolveViewsFields(helper, { permission_module, permission_action } = {}) {
  return resolveHelperFields(helper, { permission_module, permission_action });
}
