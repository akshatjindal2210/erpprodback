import express from "express";
import { getShortages, getShortageById, createShortage, updateShortage, deleteShortage, bulkCreateShortages, previewBulkShortages, getShortageMasterList } from "../controllers/shortage.controller.js";
import { authenticate, authorize } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { getPrimeItems, getPrimeItemEntries, approvePrimeItems, rejectPrimeItems, resetPrimeItems } from "../controllers/primeItem.controller.js";

const router = express.Router();
const MOD = "production_shortage";

router.post("/list", authenticate, accessControl(MOD, "view"), getShortages);
router.post("/master-list", authenticate, accessControl(MOD, "view"), getShortageMasterList);
router.post("/get", authenticate, accessControl(MOD, "view"), getShortageById);
router.post("/create", authenticate, accessControl(MOD, "add"), createShortage);
router.post("/update", authenticate, accessControl(MOD, ["edit", "authorize"]), updateShortage);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deleteShortage);
router.post("/bulk-preview", authenticate, authorize("super_admin"), previewBulkShortages);
router.post("/bulk", authenticate, authorize("super_admin"), bulkCreateShortages);

// Prime Item tab — approve / reject need the module's authorize (approver) permission.
router.post("/prime-items/list", authenticate, accessControl(MOD, "view"), getPrimeItems);
router.post("/prime-items/entries", authenticate, accessControl(MOD, "view"), getPrimeItemEntries);
router.post("/prime-items/approve", authenticate, accessControl(MOD, "authorize"), approvePrimeItems);
router.post("/prime-items/reject", authenticate, accessControl(MOD, "authorize"), rejectPrimeItems);
router.post("/prime-items/reset", authenticate, accessControl(MOD, "authorize"), resetPrimeItems);

export default router;
