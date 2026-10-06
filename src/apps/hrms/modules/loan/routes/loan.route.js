import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { listLoan, submitLoan, updateLoan, verifyApproveLoan, verifyManagerLoan, deleteLoan, listLoanDeductions } from "../controllers/loan.controller.js";

const router = Router();
const MODULE = "hrms_loan";

router.post("/list", authenticate, accessControl(MODULE, "view"), listLoan);
router.post("/submit", authenticate, accessControl(MODULE, "add"), submitLoan);
router.post("/update", authenticate, accessControl(MODULE, "edit"), updateLoan);
router.post("/verify/approve", authenticate, accessControl(MODULE, "authorize"), verifyApproveLoan);
router.post("/verify/manager", authenticate, accessControl(MODULE, "view"), verifyManagerLoan);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteLoan);

router.post("/deductions/list", authenticate, accessControl(MODULE, "view"), listLoanDeductions);

export default router;
