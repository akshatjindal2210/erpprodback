import express from "express";
import { getIssueRequests, getIssueRequestById, getJobCardIssueSummary, createIssueRequest, updateIssueRequestCtrl, deleteIssueRequest } from "../controllers/issueRequest.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_issue_request";

router.post("/list", authenticate, accessControl(MODULE, "view"), getIssueRequests);
router.post("/get", authenticate, accessControl(MODULE, "view"), getIssueRequestById);
router.post("/job-card-summary", authenticate, accessControl(MODULE, "view"), getJobCardIssueSummary);
router.post("/create", authenticate, accessControl(MODULE, "add"), createIssueRequest);
router.post("/update", authenticate, accessControl(MODULE, "edit"), updateIssueRequestCtrl);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), updateIssueRequestCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteIssueRequest);

export default router;
