import express from "express";
import {
  getRedTickets,
  getRedTicketById,
  createRedTicket,
  updateRedTicket,
  deleteRedTicket,
} from "../controllers/redTicket.controller.js";
import { authenticate, authorize, activityLogger } from "../shared/index.js";
import { accessControl } from "../../core/middleware/accessControl.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);
router.get("/", allRoles, accessControl("red_ticket", "view"), getRedTickets);
router.get("/:id", allRoles, accessControl("red_ticket", "view"), getRedTicketById);
router.post("/", allRoles, accessControl("red_ticket", "add"), activityLogger, createRedTicket);
router.put("/:id", allRoles, accessControl("red_ticket", "edit"), activityLogger, updateRedTicket);
router.delete("/:id", allRoles, accessControl("red_ticket", "delete"), activityLogger, deleteRedTicket);

export default router;
