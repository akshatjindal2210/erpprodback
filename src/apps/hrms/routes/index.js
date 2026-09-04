import { Router } from "express";

import attendanceLogRoutes from "../modules/attendance-log/routes/attendanceLog.route.js";
import attendanceRoutes from "../modules/attendance/routes/attendance.route.js";
import employeeRoutes from "../modules/employee/routes/employee.route.js";

const router = Router();

router.use("/attendance-log", attendanceLogRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/employees", employeeRoutes);

export default router;
