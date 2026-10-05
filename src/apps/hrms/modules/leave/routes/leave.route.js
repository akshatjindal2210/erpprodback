import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { listLeave, submitLeave, updateLeave, verifyHrLeave, verifyManagerLeave, deleteLeave } from "../controllers/leave.controller.js";

const router = Router();
const MODULE = "hrms_leave";

router.post("/list", authenticate, accessControl(MODULE, "view"), listLeave);
router.post("/submit", authenticate, accessControl(MODULE, "add"), submitLeave);
router.post("/update", authenticate, accessControl(MODULE, "edit"), updateLeave);
router.post("/verify/hr", authenticate, accessControl(MODULE, "authorize"), verifyHrLeave);
router.post("/verify/manager", authenticate, accessControl(MODULE, "edit"), verifyManagerLeave);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteLeave);

export default router;
