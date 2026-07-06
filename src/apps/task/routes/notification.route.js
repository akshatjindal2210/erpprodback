import express from "express";
import { authenticate, authorize } from "../shared/index.js";
import { getChannels, getTemplates, updateTemplate, getNotificationLogs, sendInstantNotification } from "../controllers/notification.controller.js";
const router = express.Router();
const superAdmin = authorize("super_admin");

router.use(authenticate);

router.post("/channels", superAdmin, getChannels);
router.post("/templates", superAdmin, getTemplates);
router.put("/templates/:key", superAdmin, updateTemplate);
router.post("/logs", superAdmin, getNotificationLogs);
router.post("/send", superAdmin, sendInstantNotification);

export default router;
