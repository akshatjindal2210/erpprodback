import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { listOtApproval, approveOt, rejectOt } from "../controllers/otApproval.controller.js";

const router = Router();
const MODULE = "hrms_ot_approval";

router.post("/list", authenticate, accessControl(MODULE, "view"), listOtApproval);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), approveOt);
router.post("/reject", authenticate, accessControl(MODULE, "authorize"), rejectOt);

export default router;
