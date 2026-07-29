import express from "express";
import { getRedTickets, getRedTicketById, createRedTicket, updateRedTicket, deleteRedTicket } from "../controllers/redTicket.controller.js";
import { authenticate, authorize, activityLogger } from "../../../lib/shared/index.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);

router.post("/list", allRoles, accessControl("red_ticket", "view"), getRedTickets);
router.post("/get", allRoles, accessControl("red_ticket", "view"), getRedTicketById);
router.post("/create", allRoles, accessControl("red_ticket", "add"), activityLogger, createRedTicket);
router.post("/update", allRoles, accessControl("red_ticket", "edit"), activityLogger, updateRedTicket);
router.post("/delete", allRoles, accessControl("red_ticket", "delete"), activityLogger, deleteRedTicket);

export default router;
