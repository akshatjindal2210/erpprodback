import express from "express";
import { getActivityLogs } from "../controllers/activityLog.controller.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();

router.get("/", authenticate, getActivityLogs);

export default router;
