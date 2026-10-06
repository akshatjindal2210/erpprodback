import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { listGatePass, submitGatePass, updateGatePass, verifyApproveGatePass, verifyManagerGatePass, scanGatePass, viewGatePass, deleteGatePass } from "../controllers/gatePass.controller.js";

const router = Router();
const MODULE = "hrms_gate_pass";

router.post("/list", authenticate, accessControl(MODULE, "view"), listGatePass);
router.post("/submit", authenticate, accessControl(MODULE, "add"), submitGatePass);
router.post("/update", authenticate, accessControl(MODULE, "edit"), updateGatePass);
router.post("/verify/approve", authenticate, accessControl(MODULE, "authorize"), verifyApproveGatePass);
router.post("/verify/manager", authenticate, accessControl(MODULE, "view"), verifyManagerGatePass);
router.post("/view", authenticate, viewGatePass);
router.post("/scan", authenticate, accessControl("gate_entry", "view"), scanGatePass);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteGatePass);

export default router;
