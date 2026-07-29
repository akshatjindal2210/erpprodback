import express from "express";
import { getDepartments, getDepartmentById, createDepartment, updateDepartmentData, deleteDepartmentData, getDepartmentsHelper } from "../controllers/department.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../lib/middleware/accessControl.js";
import { pageHelperAccess } from "../../../lib/middleware/pageHelperAccess.js";
import { resolveDepartmentViewsSelectFields } from "../../../lib/config/views/fields/department.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("departments", "view"), getDepartments);
router.post("/get", authenticate, accessControl("departments", "view"), getDepartmentById);
router.post("/create", authenticate, accessControl("departments", "add"), createDepartment);
router.post("/update", authenticate, accessControl("departments", "edit"), updateDepartmentData);
router.post("/delete", authenticate, accessControl("departments", "delete"), deleteDepartmentData);
router.post("/helper", authenticate, pageHelperAccess(resolveDepartmentViewsSelectFields), getDepartmentsHelper);

export default router;
