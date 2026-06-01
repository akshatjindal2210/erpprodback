import { Router } from "express";
import { getLogs } from "../controllers/activityLog.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../../core/middleware/accessControl.js";

const router = Router();

router.post("/list", authenticate, accessControl("activity_logs", "view"), getLogs);

export default router;
