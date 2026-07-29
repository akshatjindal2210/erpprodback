import express from "express";
import { getDailyReport, upsertReportReview, getReportInstance } from "../controllers/reportPanel.controller.js";
import { authenticate, authorize } from "../../../lib/shared/index.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);
router.post("/daily", allRoles, accessControl("task_report", "view"), getDailyReport);
router.post("/instance", allRoles, accessControl("task_report", "view"), getReportInstance);
router.post("/review", allRoles, accessControl("task_report", "edit"), upsertReportReview);

export default router;
