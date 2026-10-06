import { Router } from "express";

import attendanceLogRoutes from "../modules/attendance-log/routes/attendanceLog.route.js";
import attendanceRoutes from "../modules/attendance/routes/attendance.route.js";
import employeeRoutes from "../modules/employee/routes/employee.route.js";
import gatePassRoutes from "../modules/gate-pass/routes/gatePass.route.js";
import leaveRoutes from "../modules/leave/routes/leave.route.js";
import loanRoutes from "../modules/loan/routes/loan.route.js";
import loanDeductionRoutes from "../modules/loan-deduction/routes/loanDeduction.route.js";
import otApprovalRoutes from "../modules/ot-approval/routes/otApproval.route.js";

const router = Router();

router.use("/attendance-log", attendanceLogRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/employees", employeeRoutes);
router.use("/gate-pass", gatePassRoutes);
router.use("/leave", leaveRoutes);
router.use("/loan", loanRoutes);
router.use("/loan-deduction", loanDeductionRoutes);
router.use("/ot-approval", otApprovalRoutes);

export default router;
