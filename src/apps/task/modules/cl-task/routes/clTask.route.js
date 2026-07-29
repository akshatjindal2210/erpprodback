import express from "express";
import { getClTasks, getMyClTasks, getVerificationClTasks, getClTaskInstanceDetail, createClTask, updateClTask, submitClTask, updateClTaskSubmission, verifyClTask, updateVerificationReview, deleteClTaskInstance, setClTaskActive, deleteClTask } from "../controllers/clTask.controller.js";
import { authenticate, authorize, activityLogger } from "../../../lib/shared/index.js";
import { clTaskUpload } from "../../../lib/shared/middleware/clTaskUpload.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);

router.post("/list",                allRoles, accessControl("cl_task_master", "view"), getClTasks);
router.post("/create",              allRoles, accessControl("cl_task_master", "add"), activityLogger, clTaskUpload.array("attachments", 10), createClTask);
router.post("/update",              allRoles, accessControl("cl_task_master", "edit"), activityLogger, clTaskUpload.array("attachments", 10), updateClTask);
router.post("/delete",              allRoles, accessControl("cl_task_master", "delete"), activityLogger, deleteClTask);
router.post("/approve",             allRoles, accessControl("cl_task_master", "authorize"), activityLogger, setClTaskActive);

router.post("/verification",        allRoles, accessControl("cl_task_verification", "view"), getVerificationClTasks);
router.post("/verify",              allRoles, accessControl("cl_task_verification", "add"), activityLogger, verifyClTask);
router.post("/verification-update", allRoles, accessControl("cl_task_verification", ["add", "authorize"]), activityLogger, updateVerificationReview);
router.post("/instance-delete",     allRoles, accessControl("cl_task_verification", "delete"), activityLogger, deleteClTaskInstance);

router.post("/my",                  allRoles, accessControl("cl_task", "view"), getMyClTasks);
/** Assignee / verifier / creator — auth checked inside handler. */
router.post("/instance",            allRoles, getClTaskInstanceDetail);
router.post("/submit",              allRoles, activityLogger, clTaskUpload.any(), submitClTask);
router.post("/submission-update",   allRoles, activityLogger, clTaskUpload.any(), updateClTaskSubmission);

export default router;
