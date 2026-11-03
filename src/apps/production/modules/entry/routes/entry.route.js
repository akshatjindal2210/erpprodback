import express from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { createProductionEntry, deleteProductionEntry, getProductionEntry, listProductionEntries, updateProductionEntry } from "../controllers/entry.controller.js";

const router = express.Router();
const MOD = "production_entry";

router.post("/list", authenticate, accessControl(MOD, "view"), listProductionEntries);
router.post("/get", authenticate, accessControl(MOD, "view"), getProductionEntry);
router.post("/create", authenticate, accessControl(MOD, "add"), createProductionEntry);
router.post("/update", authenticate, accessControl(MOD, "edit"), updateProductionEntry);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deleteProductionEntry);

export default router;
