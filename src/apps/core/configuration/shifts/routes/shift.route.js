import express from "express";
import { getShifts, getShiftById, createShift, updateShiftData, deleteShiftData, toggleShiftStatus } from "../controllers/shift.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { superAdminOnly } from "../../../lib/middleware/accessControl.js";

const router = express.Router();

router.use(authenticate, superAdminOnly);

router.post("/list", getShifts);
router.post("/get", getShiftById);
router.post("/create", createShift);
router.post("/update", updateShiftData);
router.post("/toggle-status", toggleShiftStatus);
router.post("/delete", deleteShiftData);

export default router;
