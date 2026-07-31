import express from "express";
import { getIssueRequests, getIssueRequestJobCardRows, getIssueRequestById, getJobCardIssueSummary, getAvailableCoils, createIssueRequest, updateIssueRequestCtrl, deleteIssueRequest, lockIssueRequestForStoreOut, unlockIssueRequestForStoreOut } from "../controllers/issueRequest.controller.js";
import { authenticate, authorize } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_issue_request";

router.post("/list", authenticate, accessControl(MODULE, "view"), getIssueRequests);
router.post("/list-job-cards", authenticate, accessControl(MODULE, "view"), getIssueRequestJobCardRows);
router.post("/get", authenticate, accessControl(MODULE, "view"), getIssueRequestById);
router.post("/job-card-summary", authenticate, accessControl(MODULE, "view"), getJobCardIssueSummary);
router.post("/available-coils", authenticate, accessControl(MODULE, "view"), getAvailableCoils);
router.post("/create", authenticate, accessControl(MODULE, "add"), createIssueRequest);
router.post("/update", authenticate, accessControl(MODULE, "edit"), updateIssueRequestCtrl);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), updateIssueRequestCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteIssueRequest);
router.post("/lock-store-out", authenticate, authorize("super_admin"), lockIssueRequestForStoreOut);
router.post("/unlock-store-out", authenticate, authorize("super_admin"), unlockIssueRequestForStoreOut);

export default router;
