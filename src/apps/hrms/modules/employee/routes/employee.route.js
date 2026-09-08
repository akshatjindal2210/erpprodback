import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/employeeHelperViews.js";
import { deactivateEmployeeOnMachine, getEmployeesHelper, getEmployee, listEmployees, syncEmployees, updateEmployeeOnMachine } from "../controllers/employee.controller.js";

const router = Router();

router.post("/list", authenticate, accessControl("hrms_employee", "view"), listEmployees);
router.post("/sync", authenticate, accessControl("hrms_employee", "view"), syncEmployees);
router.post("/get", authenticate, accessControl("hrms_employee", "view"), getEmployee);
router.post("/machine/update", authenticate, accessControl("hrms_employee", "add"), updateEmployeeOnMachine);
router.post("/machine/deactivate", authenticate, accessControl("hrms_employee", "add"), deactivateEmployeeOnMachine);
router.post("/helper", authenticate, helperAccess("employees"), getEmployeesHelper);

export default router;
