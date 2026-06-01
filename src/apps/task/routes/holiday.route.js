import express from "express";
import { getHolidays, getHolidayById, createHoliday, updateHoliday, deleteHoliday, bulkUploadHolidays } from "../controllers/holiday.controller.js";
import { authenticate, authorize, activityLogger, csvUpload } from "../shared/index.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");
const staffOnly = authorize("super_admin", "admin");

router.use(authenticate);
router.get("/", allRoles, getHolidays);
router.get("/:id", allRoles, getHolidayById);
router.post("/", staffOnly, activityLogger, createHoliday);
router.post("/bulk-upload", staffOnly, activityLogger, csvUpload.single("file"), bulkUploadHolidays);
router.put("/:id", staffOnly, activityLogger, updateHoliday);
router.delete("/:id", staffOnly, activityLogger, deleteHoliday);

export default router;
