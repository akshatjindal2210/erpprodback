import express from "express";
import { getJobCardRegister, getJobCardPending, getPendingShortageForJobCard, createJobCard, getPrimeProcess, estimateJobCardProduction, getJobCardById, updateJobCardById,
  approveJobCardById, deleteJobCardById, getSuggestedErpJobcardno } from "../controllers/jobCard.controller.js";
import { authenticate, authorize } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();
const MOD = "production_job_card";

router.post("/register", authenticate, accessControl(MOD, "view"), getJobCardRegister);
/** Board / Calendar — page sends permission_module (production_planning), not Maintain JC. */
router.post("/register-helper", authenticate, helperAccess("jobCard"), getJobCardRegister);
router.post("/pending", authenticate, accessControl(MOD, "view"), getJobCardPending);
router.post("/pending-shortage", authenticate, accessControl(MOD, "view"), getPendingShortageForJobCard);
router.post("/prime-process", authenticate, accessControl(MOD, "view"), getPrimeProcess);
router.post("/estimate-production", authenticate, accessControl(MOD, "view"), estimateJobCardProduction);
router.post("/get", authenticate, accessControl(MOD, "view"), getJobCardById);
router.post("/get-helper", authenticate, helperAccess("jobCard"), getJobCardById);
router.post("/suggest-erp-no", authenticate, authorize("super_admin"), getSuggestedErpJobcardno);
router.post("/create", authenticate, accessControl(MOD, "add"), createJobCard);
router.post("/update", authenticate, accessControl(MOD, ["edit", "authorize"]), updateJobCardById);
router.post("/update-helper", authenticate, helperAccess("jobCard"), updateJobCardById);
router.post("/approve", authenticate, accessControl(MOD, "authorize"), approveJobCardById);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deleteJobCardById);

export default router;
