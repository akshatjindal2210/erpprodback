import express from "express";
import { authenticate, authorize } from "../shared/index.js";
import { getChannels, getTemplates, updateTemplate, getNotificationLogs } from "../controllers/notification.controller.js";
const router = express.Router();
const superAdmin = authorize("super_admin");

router.use(authenticate);

router.get("/channels", superAdmin, getChannels);
router.get("/templates", superAdmin, getTemplates);
router.put("/templates/:key", superAdmin, updateTemplate);
router.get("/logs", superAdmin, getNotificationLogs);

export default router;
