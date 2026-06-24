import express from "express";
import { getSchedulePlanning } from "../controllers/schedulePlanning.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../../core/middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("schedule_planning", "view"), getSchedulePlanning);

export default router;
