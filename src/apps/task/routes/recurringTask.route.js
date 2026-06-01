import express from "express";
import { getRecurringTasks, getRecurringTaskById, createRecurringTask, updateRecurringTask, deleteRecurringTask, getRecurringTaskStats, removeAttachmentFromRecurringTask } from "../controllers/recurringTask.controller.js";
import { authenticate, authorize, activityLogger, recurringUpload } from "../shared/index.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);

router.get("/", allRoles, getRecurringTasks);
router.get("/stats", allRoles, getRecurringTaskStats);
router.get("/:id", allRoles, getRecurringTaskById);

// Route intentionally disabled to preserve existing behavior.
// router.post("/", staffOnly, activityLogger, createRecurringTask);

router.put("/:id", allRoles, recurringUpload.array("attachments", 10), activityLogger, updateRecurringTask);
router.delete("/:id", allRoles, activityLogger, deleteRecurringTask);
router.delete("/:id/attachments", allRoles, activityLogger, removeAttachmentFromRecurringTask);

export default router;
