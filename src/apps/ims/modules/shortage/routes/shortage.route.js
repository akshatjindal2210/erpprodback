import express from "express";
import { getShortages, getShortageById, createShortage, updateShortage, deleteShortage, bulkCreateShortages, previewBulkShortages, createPackingDeviation } from "../controllers/shortage.controller.js";
import { authenticate, authorize } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MOD = "shortage";

router.post("/list", authenticate, accessControl(MOD, "view"), getShortages);
router.post("/get", authenticate, accessControl(MOD, "view"), getShortageById);
router.post("/create", authenticate, accessControl(MOD, "add"), createShortage);
router.post("/update", authenticate, accessControl(MOD, ["edit", "authorize"]), updateShortage);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deleteShortage);
router.post("/bulk-preview", authenticate, authorize("super_admin"), previewBulkShortages);
router.post("/bulk", authenticate, authorize("super_admin"), bulkCreateShortages);
router.post("/packing-deviation", authenticate, accessControl("packing_entry", ["view", "add", "edit"]), createPackingDeviation);

export default router;
