import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const VIEW = "view";
const FORM_ACTIONS = ["add", "edit", "authorize"];
const isForm = (act) => FORM_ACTIONS.includes(act);

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

export function helperAccess(helper) {
  return (req, res, next) => {
    const page = req.body?.permission_module;
    const action = req.body?.permission_action;

    if (!page || !action) {
      return res.status(400).json({
        success: false,
        message: "permission_module and permission_action required",
      });
    }

    if (resolveHelperFields(helper, { permission_module: page, permission_action: action }) == null) {
      return res.status(403).json({
        success: false,
        message: "Not allowed.",
      });
    }

    const userType = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
    if (userType === "super_admin") return next();

    return accessControl(page, action)(req, res, next);
  };
}

export function toEmployeePickerRow(row) {
  if (!row) return null;
  return {
    id: row.emp_dcode,
    emp_dcode: row.emp_dcode,
    emp_code: row.emp_code,
    emp_name: row.emp_name,
    deptcode: row.deptcode,
    brcode: row.brcode,
    emp_intime: row.emp_intime,
    emp_outtime: row.emp_outtime,
    emp_intime_display: row.emp_intime_display,
    emp_outtime_display: row.emp_outtime_display,
  };
}
