import { Router } from "express";
import multer from "multer";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { ingestHikvisionEvents } from "../../attendance-log/controllers/attendanceLog.controller.js";
import { listAttendance, previewAttendance, submitAttendance, updateAttendance, deleteAttendance } from "../controllers/attendance.controller.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
const moduleName = "hrms_attendance";

router.post("/device-events", upload.any(), ingestHikvisionEvents);
router.post("/list", authenticate, accessControl(moduleName, "view"), listAttendance);
router.post("/preview", authenticate, accessControl(moduleName, ["view", "add"]), previewAttendance);
router.post("/submit", authenticate, accessControl(moduleName, "add"), submitAttendance);
router.post("/update", authenticate, accessControl(moduleName, ["edit", "authorize"]), updateAttendance);
router.post("/delete", authenticate, accessControl(moduleName, "delete"), deleteAttendance);

export default router;
