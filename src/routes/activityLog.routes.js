import express from "express";
import { authenticate, authorize } from "../middleware/auth.js";
import { deleteLog, getLogById, getLogs, updateLog } from "../controllers/activityLog.controller.js";
import { accessControl } from "../middleware/accessControl.js";

const router = express.Router();

// ─── GET all modules
router.post("/list", authenticate, accessControl("activity_logs", "view"), getLogs);

export default router;