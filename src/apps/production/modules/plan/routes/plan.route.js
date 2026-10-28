import express from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { getPlanningTable } from "../controllers/plan.controller.js";

const router = express.Router();
const MOD = "production_planning";

/** Board, Calendar, Table — Admin → Production Planning. */
router.post("/table", authenticate, accessControl(MOD, "view"), getPlanningTable);

export default router;
