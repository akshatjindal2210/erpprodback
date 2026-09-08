import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { getAttendanceLogImage, getAttendanceLogImageProxy, ingestHikvisionEvents, listAttendanceLogs, syncAttendanceLogs } from "../controllers/attendanceLog.controller.js";

const router = Router();

router.post("/events", ingestHikvisionEvents);
router.post("/list", authenticate, accessControl("hrms_attendance_log", "view"), listAttendanceLogs);
router.post("/sync", authenticate, accessControl("hrms_attendance_log", "view"), syncAttendanceLogs);
router.post("/image", authenticate, accessControl("hrms_attendance_log", "view"), getAttendanceLogImage);
router.get("/image-proxy", authenticate, accessControl("hrms_attendance_log", "view"), getAttendanceLogImageProxy);

export default router;
