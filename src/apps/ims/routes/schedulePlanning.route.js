import express from "express";
import { getSchedulePlanning, getScheduleActionDates, saveSchedulePlanning, rejectSchedulePlanning, holdSchedulePlanning, getScheduleItemTransactions, submitScheduleShortagePlanning, deleteSchedulePlanning, getScheduleDispatchPlan, completeSchedulePlanning } from "../controllers/schedulePlanning.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../../core/middleware/accessControl.js";
import { helperAccess } from "../config/helperViews.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("schedule_planning", "view"), getSchedulePlanning);
router.post("/action-dates", authenticate, accessControl("schedule_planning", "view"), getScheduleActionDates);
router.post("/transactions", authenticate, accessControl("schedule_planning", "view"), getScheduleItemTransactions);
router.post("/save", authenticate, accessControl("schedule_planning", "add"), saveSchedulePlanning);    // add or reschedule
router.post("/reject", authenticate, accessControl("schedule_planning", "edit"), rejectSchedulePlanning);
router.post("/hold", authenticate, accessControl("schedule_planning", "edit"), holdSchedulePlanning);
router.post("/shortage", authenticate, accessControl("schedule_planning", "edit"), submitScheduleShortagePlanning);
router.post("/complete", authenticate, accessControl("schedule_planning", "add"), completeSchedulePlanning);
router.post("/delete", authenticate, accessControl("schedule_planning", "delete"), deleteSchedulePlanning);

// Dispatch-plan helper (Forwarding Note "Today Dispatch Plan" tab) — no fin_year_id required
router.post("/dispatch-helper", authenticate, helperAccess("schedulePlanning"), getScheduleDispatchPlan);

export default router;
