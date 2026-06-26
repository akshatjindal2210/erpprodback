import express from "express";
import { getModules, getModuleById, createModule, updateModuleData, toggleModuleStatus, getModulesViews } from "../controllers/module.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("modules", "view"), getModules);

router.post("/get", authenticate, accessControl("modules", "view"), getModuleById);

router.post("/create", authenticate, accessControl("modules", "add"), createModule);

router.post("/update", authenticate, accessControl("modules", "edit"), updateModuleData);

router.post("/toggle-status", authenticate, accessControl("modules", "edit"), toggleModuleStatus);

router.post("/helper", authenticate, dynamicAccessControl(), getModulesViews);

export default router;