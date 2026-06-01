import express from "express";
import { getPackingStandards, getPackingStandardById, createPackingStandard, updatePackingStandard, deletePackingStandard, getPackingStandardsViews } from "../controllers/packingStandard.controller.js";

import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../../core/middleware/accessControl.js";

const router = express.Router();

// Get list
router.post("/list", authenticate, accessControl("packing_standard", "view"), getPackingStandards);

// Get single
router.post("/get", authenticate, accessControl("packing_standard", "view"), getPackingStandardById);

// Create
router.post("/create", authenticate, accessControl("packing_standard", "add"), createPackingStandard);

// Update (allow both edit users and authorize users)
router.post("/update", authenticate, accessControl("packing_standard", ["edit", "authorize"]), updatePackingStandard);

// Delete
router.post("/delete", authenticate, accessControl("packing_standard", "delete"), deletePackingStandard);

// Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getPackingStandardsViews);

export default router;
