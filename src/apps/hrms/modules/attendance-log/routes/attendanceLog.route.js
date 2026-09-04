import { Router } from "express";
import multer from "multer";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { ingestHikvisionEvents, listAttendanceLogs } from "../controllers/attendanceLog.controller.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/events", upload.any(), ingestHikvisionEvents);
router.post("/list", authenticate, accessControl("hrms_attendance_log", "view"), listAttendanceLogs);

export default router;
