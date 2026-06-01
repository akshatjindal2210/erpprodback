import express from "express";
import { authenticate, authorize, chatUpload, selfUpload } from "../shared/index.js";
import { getTasks, getTaskById, createTask, createSelfTask, assignSubUsers, updateTask, deleteTask, forwardTask, requestCompletion, approveSubUser, rejectSubUser, creatorDecision, getTaskActivity, reassignTask } from "../controllers/task.controller.js";
import { getChat, sendMessage, deleteMessage } from "../controllers/taskChat.controller.js";
import { getSelfNote, upsertSelfNote, deleteSelfNote, toggleRecurringTaskStatus } from "../controllers/taskSelfNote.controller.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);

router.get("/", allRoles, getTasks);
router.get("/:id", allRoles, getTaskById);

router.post("/self", allRoles, chatUpload.array("attachments", 10), createSelfTask);
router.post("/", allRoles, chatUpload.array("attachments", 10), createTask);

router.put("/:id", allRoles, chatUpload.array("attachments", 10), updateTask);
router.delete("/:id", allRoles, deleteTask);

router.post("/:id/sub-users", allRoles, assignSubUsers);
router.post("/:id/forward", allRoles, forwardTask);
router.post("/:id/reassign", allRoles, reassignTask);
router.post("/:id/request-completion", allRoles, requestCompletion);
router.post("/:id/approve-sub/:assignmentId", allRoles, approveSubUser);
router.post("/:id/reject-sub/:assignmentId", allRoles, rejectSubUser);
router.post("/:id/creator-decision", allRoles, creatorDecision);
router.get("/:id/activity", allRoles, getTaskActivity);

router.get("/:id/chat", allRoles, getChat);
router.post("/:id/chat", allRoles, chatUpload.array("files", 10), sendMessage);
router.delete("/:id/chat/:chatId", allRoles, deleteMessage);

router.get("/:id/self-note", allRoles, getSelfNote);
router.put("/:id/self-note", allRoles, selfUpload.array("files", 10), upsertSelfNote);
router.delete("/:id/self-note", allRoles, deleteSelfNote);

router.post("/:id/toggle-status", allRoles, toggleRecurringTaskStatus);

export default router;
