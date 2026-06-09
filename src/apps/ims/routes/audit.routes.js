import express from "express";
import { getAudits, getAuditById, createAudit, updateAuditController, deleteAuditController, submitAuditScan, verifyAudit, removeAuditScan, getAuditComparisonReportController, logAuditComparisonAdjustment, reopenAuditLocationController, reassignAuditLocationController } from "../controllers/audit.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, superAdminOnly } from "../../core/middleware/accessControl.js";

const router = express.Router();

router.use(authenticate);

router.post("/list", accessControl("audit", "view"), getAudits);
router.post("/get", accessControl("audit", "view"), getAuditById);
router.post("/create", accessControl("audit", "authorize"), createAudit);
router.post("/update", accessControl("audit", ["edit", "authorize"]), updateAuditController);
router.post("/delete", accessControl("audit", "delete"), deleteAuditController);
router.post("/submit-scan", accessControl("audit", "add"), submitAuditScan);
router.post("/remove-scan", accessControl("audit", "add"), removeAuditScan);
router.post("/comparison-report", accessControl("audit", "view"), getAuditComparisonReportController);
router.post("/comparison-adjustment", accessControl("audit", "view"), logAuditComparisonAdjustment);
router.post("/reopen-location", accessControl("audit", ["edit", "authorize"]), reopenAuditLocationController);
router.post("/reassign-location", accessControl("audit", ["edit", "authorize"]), reassignAuditLocationController);
router.post("/verify", superAdminOnly, verifyAudit);

export default router;
