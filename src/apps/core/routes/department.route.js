import express from "express";
import { getDepartments, getDepartmentById, createDepartment, updateDepartmentData, deleteDepartmentData, getDepartmentsHelper } from "../controllers/department.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("departments", "view"), getDepartments);
router.post("/get", authenticate, accessControl("departments", "view"), getDepartmentById);
router.post("/create", authenticate, accessControl("departments", "add"), createDepartment);
router.post("/update", authenticate, accessControl("departments", "edit"), updateDepartmentData);
router.post("/delete", authenticate, accessControl("departments", "delete"), deleteDepartmentData);
router.post("/helper", authenticate, getDepartmentsHelper);

export default router;
