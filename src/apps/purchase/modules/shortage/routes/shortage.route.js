import express from "express";
import { getShortages, getShortageById, createShortage, updateShortage, deleteShortage, bulkCreateShortages, previewBulkShortages, getShortageMasterList } from "../controllers/shortage.controller.js";
import { authenticate, authorize } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MOD = "purchase_shortage";

router.post("/list", authenticate, accessControl(MOD, "view"), getShortages);
router.post("/master-list", authenticate, accessControl(MOD, "view"), getShortageMasterList);
router.post("/get", authenticate, accessControl(MOD, "view"), getShortageById);
router.post("/create", authenticate, accessControl(MOD, "add"), createShortage);
router.post("/update", authenticate, accessControl(MOD, ["edit", "authorize"]), updateShortage);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deleteShortage);
router.post("/bulk-preview", authenticate, authorize("super_admin"), previewBulkShortages);
router.post("/bulk", authenticate, authorize("super_admin"), bulkCreateShortages);

export default router;
