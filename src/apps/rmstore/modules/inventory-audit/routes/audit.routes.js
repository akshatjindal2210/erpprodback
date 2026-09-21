import express from "express";
import { getAudits, getAuditById, createAudit, updateAuditController, deleteAuditController, submitAuditScan, startAuditLocationController, verifyAudit, removeAuditScan, getAuditComparisonReportController, applyAuditComparisonAdjustmentController, completeAuditLocationController, getAuditScoresController, reopenAuditLocationController, reassignAuditLocationController } from "../controllers/audit.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl, superAdminOnly } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();

router.use(authenticate);

router.post("/list", accessControl("rm_inventory_audit", "view"), getAudits);
router.post("/get", accessControl("rm_inventory_audit", "view"), getAuditById);
router.post("/create", accessControl("rm_inventory_audit", "authorize"), createAudit);
router.post("/update", accessControl("rm_inventory_audit", ["edit", "authorize"]), updateAuditController);
router.post("/delete", accessControl("rm_inventory_audit", "delete"), deleteAuditController);
router.post("/submit-scan", accessControl("rm_inventory_audit", "add"), submitAuditScan);
router.post("/start-location", accessControl("rm_inventory_audit", "add"), startAuditLocationController);
router.post("/remove-scan", accessControl("rm_inventory_audit", "add"), removeAuditScan);
router.post("/scores", accessControl("rm_inventory_audit", "view"), getAuditScoresController);
router.post("/reopen-location", accessControl("rm_inventory_audit", ["edit", "authorize"]), reopenAuditLocationController);
router.post("/reassign-location", accessControl("rm_inventory_audit", ["edit", "authorize"]), reassignAuditLocationController);

router.post("/verify", superAdminOnly, verifyAudit);

router.post("/comparison-report", accessControl("rm_inventory_audit", "view"), getAuditComparisonReportController);
router.post("/comparison-adjustment", accessControl("rm_inventory_audit", ["edit", "authorize"]), applyAuditComparisonAdjustmentController);
router.post("/complete-location", accessControl("rm_inventory_audit", ["edit", "authorize"]), completeAuditLocationController);

export default router;
