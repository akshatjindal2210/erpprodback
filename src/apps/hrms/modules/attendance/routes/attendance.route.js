import { Router } from "express";
import multer from "multer";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { ingestDeviceEvents, listAttendance, markAttendance, previewAttendance, submitAttendance, updateAttendance, deleteAttendance, approveAttendance } from "../controllers/attendance.controller.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
const moduleName = "hrms_attendance";

router.post("/device-events", upload.any(), ingestDeviceEvents);
router.post("/list", authenticate, accessControl(moduleName, "view"), listAttendance);
router.post("/preview", authenticate, accessControl(moduleName, ["view", "add"]), previewAttendance);
router.post("/mark", authenticate, accessControl(moduleName, "add"), markAttendance);
router.post("/submit", authenticate, accessControl(moduleName, "add"), submitAttendance);
router.post("/update", authenticate, accessControl(moduleName, "edit"), updateAttendance);
router.post("/delete", authenticate, accessControl(moduleName, "delete"), deleteAttendance);
router.post("/approve", authenticate, accessControl(moduleName, "authorize"), approveAttendance);

export default router;
