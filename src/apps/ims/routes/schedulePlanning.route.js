import express from "express";
import { getSchedulePlanning, getScheduleActionDates, saveSchedulePlanning, rejectSchedulePlanning, holdSchedulePlanning, readyToDispatchSchedulePlanning, getScheduleItemTransactions, submitScheduleShortagePlanning, deleteSchedulePlanning, getScheduleDispatchPlan, getCustomerMonthSchedules, completeSchedulePlanning } from "../controllers/schedulePlanning.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../../core/middleware/accessControl.js";
import { helperAccess } from "../config/helperViews.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("schedule_planning", "view"), getSchedulePlanning);
router.post("/action-dates", authenticate, accessControl("schedule_planning", "view"), getScheduleActionDates);
router.post("/transactions", authenticate, accessControl("schedule_planning", "view"), getScheduleItemTransactions);

/** ADD: Plan, Reject, Complete */
router.post("/save", authenticate, accessControl("schedule_planning", "add"), saveSchedulePlanning);
router.post("/reject", authenticate, accessControl("schedule_planning", "add"), rejectSchedulePlanning);
router.post("/complete", authenticate, accessControl("schedule_planning", "add"), completeSchedulePlanning);

/** APPROVE: Hold, Ready to Dispatch, Shortage */
router.post("/hold", authenticate, accessControl("schedule_planning", "authorize"), holdSchedulePlanning);
router.post("/ready-to-dispatch", authenticate, accessControl("schedule_planning", "authorize"), readyToDispatchSchedulePlanning);
router.post("/shortage", authenticate, accessControl("schedule_planning", "authorize"), submitScheduleShortagePlanning);

router.post("/delete", authenticate, accessControl("schedule_planning", "delete"), deleteSchedulePlanning);

router.post("/dispatch-helper", authenticate, helperAccess("schedulePlanning"), getScheduleDispatchPlan);
router.post("/customer-month-schedules", authenticate, accessControl("forwarding_note_master", "view"), getCustomerMonthSchedules);

export default router;
