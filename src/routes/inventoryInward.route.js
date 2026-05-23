import express from "express";
import { getInventoryInwards, getInventoryInwardById, createInventoryInward, updateInventoryInward, deleteInventoryInward, getInventoryInwardsViews, validateInwardBoxAtLocation, batchScanInwardBoxes } from "../controllers/inventoryInward.controller.js";

import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

// List
router.post("/list", authenticate, accessControl("inventory_inwards", "view"), getInventoryInwards);

// Get single
router.post("/get", authenticate, accessControl("inventory_inwards", "view"), getInventoryInwardById);

// Validate box at location (scan-time; same rules as save when inward_location_validation is true)
router.post("/validate-box-location", authenticate, accessControl("inventory_inwards", ["view", "add", "edit", "authorize"]), validateInwardBoxAtLocation );

// Batch resolve + validate scanned boxes (fast multi-scan path)
router.post("/batch-scan-boxes", authenticate, accessControl("inventory_inwards", ["view", "add", "edit", "authorize"]), batchScanInwardBoxes);

// Create
router.post("/create", authenticate, accessControl("inventory_inwards", "add"), createInventoryInward);

// Update (allow both edit users and authorize users)
router.post("/update", authenticate, accessControl("inventory_inwards", ["edit", "authorize"]), updateInventoryInward);

// Delete
router.post("/delete", authenticate, accessControl("inventory_inwards", "delete"), deleteInventoryInward);

// Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getInventoryInwardsViews);

export default router;