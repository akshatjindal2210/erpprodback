import express from "express";
import { getJobCardRegister, getJobCardPending, getPendingShortageForJobCard, createJobCard, getPrimeProcess, getJobCardById, updateJobCardById, approveJobCardById, deleteJobCardById } from "../controllers/jobCard.controller.js";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MOD = "production_job_card";

router.post("/register", authenticate, accessControl(MOD, "view"), getJobCardRegister);
router.post("/pending", authenticate, accessControl(MOD, "view"), getJobCardPending);
router.post("/pending-shortage", authenticate, accessControl(MOD, "view"), getPendingShortageForJobCard);
router.post("/prime-process", authenticate, accessControl(MOD, "view"), getPrimeProcess);
router.post("/get", authenticate, accessControl(MOD, "view"), getJobCardById);
router.post("/create", authenticate, accessControl(MOD, "add"), createJobCard);
router.post("/update", authenticate, accessControl(MOD, ["edit", "authorize"]), updateJobCardById);
router.post("/approve", authenticate, accessControl(MOD, "authorize"), approveJobCardById);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deleteJobCardById);

export default router;
