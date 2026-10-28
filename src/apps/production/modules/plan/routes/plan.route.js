import express from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { deletePlanningLine, getPlanningLine, getPlanningTable, updatePlanningLine } from "../controllers/plan.controller.js";

const router = express.Router();
const MOD = "production_planning";

/** Board / Calendar / Table — all read/write prod_plan (not prod_jc). */
router.post("/table", authenticate, accessControl(MOD, "view"), getPlanningTable);
router.post("/get", authenticate, accessControl(MOD, "view"), getPlanningLine);
router.post("/update", authenticate, accessControl(MOD, "edit"), updatePlanningLine);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deletePlanningLine);

export default router;
