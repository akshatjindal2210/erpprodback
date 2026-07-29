import express from "express";
import { authenticate } from "../../lib/middleware/auth.js";
import { getInbox, getInboxUnreadCount, markInboxRead, markAllInboxRead } from "./inbox.controller.js";

const router = express.Router();

router.use(authenticate);

router.get("/", getInbox);
router.get("/unread-count", getInboxUnreadCount);
router.patch("/:id/read", markInboxRead);
router.post("/read-all", markAllInboxRead);

export default router;
