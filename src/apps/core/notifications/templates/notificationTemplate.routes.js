import express from "express";
import { getNotificationTemplates, getNotificationTemplateById, createNotificationTemplate, updateNotificationTemplateController, toggleNotificationTemplate, deleteNotificationTemplateController, getNotificationTemplateLogs, getNotificationTemplateOptions, previewNotificationRecipients } from "./notificationTemplate.controller.js";
import { authenticate } from "../../lib/middleware/auth.js";
import { accessControl } from "../../lib/middleware/accessControl.js";

/** Managed from Training & SOPs — same permission module as SOPs. */
const PERM = "training_videos";

const router = express.Router();

router.use(authenticate);

router.post("/list", accessControl(PERM, "view"), getNotificationTemplates);
router.post("/get", accessControl(PERM, "view"), getNotificationTemplateById);
router.post("/options", accessControl(PERM, "view"), getNotificationTemplateOptions);
router.post("/recipients-preview", accessControl(PERM, "view"), previewNotificationRecipients);
router.post("/logs", accessControl(PERM, "view"), getNotificationTemplateLogs);
router.post("/create", accessControl(PERM, "add"), createNotificationTemplate);
router.post("/update", accessControl(PERM, "edit"), updateNotificationTemplateController);
router.post("/toggle", accessControl(PERM, "edit"), toggleNotificationTemplate);
router.post("/delete", accessControl(PERM, "delete"), deleteNotificationTemplateController);

export default router;
