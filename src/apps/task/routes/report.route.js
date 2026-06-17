import express from "express";
import { getDailyReport, upsertReportReview } from "../controllers/reportPanel.controller.js";
import { authenticate, authorize } from "../shared/index.js";
import { accessControl } from "../../core/middleware/accessControl.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);
router.get("/daily", allRoles, accessControl("task_report", "view"), getDailyReport);
router.post("/review", allRoles, accessControl("task_report", "edit"), upsertReportReview);

export default router;
