import express from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { getPlanningEmployeesHelper, getPlanningShiftOp, getPlanningShifts } from "../../plan/controllers/plan.controller.js";
import { createProductionEntry, deleteProductionEntry, getProductionEntry, getProductionEntryJcPlan, listProductionEntries, listProductionEntryJcsByMachine, updateProductionEntry } from "../controllers/entry.controller.js";

const router = express.Router();
const MOD = "production_entry";

router.post("/list", authenticate, accessControl(MOD, "view"), listProductionEntries);
router.post("/get", authenticate, accessControl(MOD, "view"), getProductionEntry);
/** Same handlers as planning — entry ACL so operators without planning access still work. */
router.post("/shifts", authenticate, accessControl(MOD, "view"), getPlanningShifts);
router.post("/shift-ops", authenticate, accessControl(MOD, "view"), getPlanningShiftOp);
router.post("/employees", authenticate, accessControl(MOD, "view"), getPlanningEmployeesHelper);
router.post("/jc-plan", authenticate, accessControl(MOD, "view"), getProductionEntryJcPlan);
router.post("/jcs-by-machine", authenticate, accessControl(MOD, "view"), listProductionEntryJcsByMachine);
router.post("/create", authenticate, accessControl(MOD, "add"), createProductionEntry);
router.post("/update", authenticate, accessControl(MOD, "edit"), updateProductionEntry);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deleteProductionEntry);

export default router;
