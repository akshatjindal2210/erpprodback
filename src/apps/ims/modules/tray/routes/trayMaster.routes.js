import express from "express";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl, accessControlAny } from "../../../../core/lib/middleware/accessControl.js";
import { createTray, deleteTray, getTrays, getTrayTypes, getTraysViews, updateTray } from "../controllers/trayMaster.controller.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();

router.post("/types", authenticate, accessControl("tray_master", "view"), getTrayTypes);
router.post("/helper", authenticate, helperAccess("trays"), getTraysViews);
router.post("/list", authenticate, accessControl("tray_master", "view"), getTrays);
router.post("/create", authenticate, accessControl("tray_master", "add"), createTray);
router.post("/update", authenticate, accessControlAny([
    { moduleName: "tray_master", actions: "edit" },
    { moduleName: "tray_master", actions: "authorize" },
  ]), updateTray
);
router.post("/delete", authenticate, accessControl("tray_master", "delete"), deleteTray);

export default router;
