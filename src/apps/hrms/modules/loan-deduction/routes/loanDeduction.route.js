import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import {
  listLoanDeductionQueue,
  listLoanDeductions,
  markLoanDeductions,
  undoLoanDeductions,
  approveLoanDeductions,
  addLoanExtraDeduction,
  updateLoanExtraDeduction,
  deleteLoanExtraDeduction,
} from "../../loan/controllers/loan.controller.js";

const router = Router();
const MODULE = "hrms_deduction";

router.post("/list", authenticate, accessControl(MODULE, "view"), listLoanDeductionQueue);
router.post("/detail", authenticate, accessControl(MODULE, "view"), listLoanDeductions);
router.post("/mark", authenticate, accessControl(MODULE, "authorize"), markLoanDeductions);
router.post("/undo", authenticate, accessControl(MODULE, "authorize"), undoLoanDeductions);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), approveLoanDeductions);
router.post("/extra", authenticate, accessControl(MODULE, "add"), addLoanExtraDeduction);
router.post("/extra/update", authenticate, accessControl(MODULE, "edit"), updateLoanExtraDeduction);
router.post("/extra/delete", authenticate, accessControl(MODULE, "delete"), deleteLoanExtraDeduction);

export default router;
