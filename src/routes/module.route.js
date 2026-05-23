import express from "express";
import { getModules, getModuleById, createModule, updateModuleData, toggleModuleStatus, getModulesViews } from "../controllers/module.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js"; // updated middleware

const router = express.Router();

// ─── GET all modules (POST body-safe)
router.post("/list", authenticate, accessControl("modules", "view"), getModules);

// ─── GET single module (POST body-safe)
router.post("/get", authenticate, accessControl("modules", "view"), getModuleById);

// ─── CREATE module
router.post("/create", authenticate, accessControl("modules", "add"), createModule);

// ─── UPDATE module
router.post("/update", authenticate, accessControl("modules", "edit"), updateModuleData);

// ─── TOGGLE STATUS (on/off — no separate module approve/delete APIs)
router.post("/toggle-status", authenticate, accessControl("modules", "edit"), toggleModuleStatus);

// ─── GET Views (active modules id/name/label — used e.g. by Training without `modules` view)
router.post("/helper", authenticate, dynamicAccessControl(), getModulesViews);

export default router;