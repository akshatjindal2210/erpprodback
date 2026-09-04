import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const VIEW = "view";
const FORM_ACTIONS = ["add", "edit", "authorize"];
const isForm = (act) => FORM_ACTIONS.includes(act);

/**
 * Which HRMS pages may call POST /employees/helper (IMS-style if/else).
 * Returns non-null when allowed; value is unused for ERP rows (access gate only).
 */
function fieldsForEmployees(mod, act) {
  if (mod == null || act == null) return null;

  if (mod === "hrms_attendance" && (act === VIEW || isForm(act))) return true;
  if (mod === "hrms_attendance_log" && act === VIEW) return true;

  return null;
}

const BY_HELPER = {
  employees: fieldsForEmployees,
};

function resolveHelperFields(helper, { permission_module, permission_action } = {}) {
  const fn = BY_HELPER[helper];
  if (!fn) return null;
  return fn(permission_module, permission_action);
}

/** Route middleware — helperAccess("employees") */
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

export function resolveEmployeeHelperAllowed({ permission_module, permission_action } = {}) {
  return resolveHelperFields("employees", { permission_module, permission_action }) != null;
}

/** Compact row for dropdowns / pickers (not full employee master list). */
export function toEmployeePickerRow(row) {
  if (!row) return null;
  return {
    id: row.emp_dcode ?? row.emp_code,
    emp_dcode: row.emp_dcode,
    emp_code: row.emp_code,
    emp_name: row.emp_name,
    deptcode: row.deptcode,
    brcode: row.brcode,
  };
}
