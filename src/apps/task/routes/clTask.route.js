import express from "express";
import { getClTasks, getMyClTasks, getVerificationClTasks, getClTaskById, createClTask, submitClTask, verifyClTask, deleteClTask } from "../controllers/clTask.controller.js";
import { authenticate, authorize, activityLogger } from "../shared/index.js";
import { clTaskUpload } from "../shared/middleware/clTaskUpload.js";
import { accessControl } from "../../core/middleware/accessControl.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);
router.get("/my", allRoles, getMyClTasks);
router.get("/verification", allRoles, accessControl("cl_task_verification", "view"), getVerificationClTasks);
router.get("/", allRoles, accessControl("cl_task", "view"), getClTasks);
router.get("/:id", allRoles, getClTaskById);
router.post("/", allRoles, accessControl("cl_task", "add"), activityLogger, createClTask);
router.post("/:id/submit", allRoles, activityLogger, clTaskUpload.any(), submitClTask);
router.post("/:id/verify", allRoles, accessControl("cl_task_verification", ["edit", "authorize"]), activityLogger, verifyClTask);
router.delete("/:id", allRoles, accessControl("cl_task", "delete"), activityLogger, deleteClTask);

export default router;
