import express from "express";
import { getHolidays, getHolidayById, createHoliday, updateHoliday, deleteHoliday, bulkUploadHolidays } from "../controllers/holiday.controller.js";
import { authenticate, authorize, activityLogger, csvUpload } from "../../../lib/shared/index.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);

router.post("/list", allRoles, accessControl("holiday", "view"), getHolidays);
router.post("/get", allRoles, accessControl("holiday", "view"), getHolidayById);
router.post("/create", allRoles, accessControl("holiday", "add"), activityLogger, createHoliday);
router.post("/update", allRoles, accessControl("holiday", "edit"), activityLogger, updateHoliday);
router.post("/delete", allRoles, accessControl("holiday", "delete"), activityLogger, deleteHoliday);
router.post("/bulk-upload", allRoles, accessControl("holiday", "add"), activityLogger, csvUpload.single("file"), bulkUploadHolidays);

export default router;
