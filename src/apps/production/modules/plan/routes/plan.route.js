import express from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { deletePlanningLine, getPlanningEmployeesHelper, getPlanningLine, getPlanningShiftOp, getPlanningShifts, getPlanningTable, savePlanningShiftOp, updatePlanningShiftOp, deletePlanningShiftOp, 
  updatePlanningLine } from "../controllers/plan.controller.js";

const router = express.Router();
const MOD = "production_planning";

/** Board / Calendar / Table — all read/write prod_plan (not prod_jc). */
router.post("/table", authenticate, accessControl(MOD, "view"), getPlanningTable);
router.post("/get", authenticate, accessControl(MOD, "view"), getPlanningLine);
router.post("/update", authenticate, accessControl(MOD, "edit"), updatePlanningLine);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deletePlanningLine);

/** Calendar shifts (Settings) + machine/shift operator (light). */
router.post("/shifts", authenticate, accessControl(MOD, "view"), getPlanningShifts);
router.post("/shift-op/get", authenticate, accessControl(MOD, "view"), getPlanningShiftOp);

/** New occupy → add permission. */
router.post("/shift-op/save", authenticate, accessControl(MOD, "add"), savePlanningShiftOp);
router.post("/shift-op/update", authenticate, accessControl(MOD, "edit"), updatePlanningShiftOp);
router.post("/shift-op/delete", authenticate, accessControl(MOD, "delete"), deletePlanningShiftOp);
router.post("/employees/helper", authenticate, accessControl(MOD, "view"), getPlanningEmployeesHelper);

export default router;
