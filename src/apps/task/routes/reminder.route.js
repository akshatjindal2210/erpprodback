import express from "express";
import { getReminders } from "../controllers/reminder.controller.js";
import { authenticate, authorize } from "../shared/index.js";

const router = express.Router();

router.use(authenticate);
router.get("/", authorize("super_admin", "admin", "user", "executive_assistant"), getReminders);

export default router;
