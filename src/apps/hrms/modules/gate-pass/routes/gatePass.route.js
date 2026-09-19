import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { listGatePass, submitGatePass, updateGatePass, verifyHrGatePass, verifyManagerGatePass, deleteGatePass } from "../controllers/gatePass.controller.js";

const router = Router();
const MODULE = "hrms_gate_pass";

router.post("/list", authenticate, accessControl(MODULE, "view"), listGatePass);
router.post("/submit", authenticate, accessControl(MODULE, "add"), submitGatePass);
router.post("/update", authenticate, accessControl(MODULE, "edit"), updateGatePass);
router.post("/verify/hr", authenticate, accessControl(MODULE, "authorize"), verifyHrGatePass);
router.post("/verify/manager", authenticate, accessControl(MODULE, "edit"), verifyManagerGatePass);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteGatePass);

export default router;
