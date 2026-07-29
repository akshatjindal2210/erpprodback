import express from "express";
import { getQcChecks, getQcCheckById, prepareQcCheck, submitQcCheck, approveQcCheck, reopenQcCheck, deleteQcCheck } from "../controllers/qcCheck.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { rmQcDocUpload } from "../../../lib/middleware/upload.js";

const router = express.Router();
const MODULE = "rm_qc_check";

router.post("/list", authenticate, accessControl(MODULE, "view"), getQcChecks);
router.post("/get", authenticate, accessControl(MODULE, "view"), getQcCheckById);
router.post("/prepare", authenticate, accessControl(MODULE, "view"), prepareQcCheck);
router.post("/submit", authenticate, accessControl(MODULE, "add"), rmQcDocUpload.any(), submitQcCheck);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), rmQcDocUpload.any(), approveQcCheck);
router.post("/reopen", authenticate, accessControl(MODULE, "edit"), reopenQcCheck);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteQcCheck);

export default router;
