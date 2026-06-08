import express from "express";
import { getOutEntries, getOutEntryById, createOutEntry, updateOutEntry, deleteOutEntry, verifyBoxSticker, batchScanOutEntryBoxes, getFuidDetailsForOutEntry, lockFuidForOutEntry, getOutEntriesViews, getOutEntryReasonsViews } from "../controllers/outEntry.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../../core/middleware/accessControl.js";

const router = express.Router();

// List
router.post("/list", authenticate, accessControl("out_entry", "view"), getOutEntries);

// Get single
router.post("/get", authenticate, accessControl("out_entry", "view"), getOutEntryById);

// Create
router.post("/create", authenticate, accessControl("out_entry", "add"), createOutEntry);


// Update (allow both edit users and authorize users)
router.post("/update", authenticate, accessControl("out_entry", ["edit", "authorize"]), updateOutEntry);

// Delete
router.post("/delete", authenticate, accessControl("out_entry", "delete"), deleteOutEntry);

// Get Forwarding Note details for Out Entry
router.post("/get-details", authenticate, accessControl("out_entry", "view"), getFuidDetailsForOutEntry);

router.post("/lock-fuid", authenticate, accessControl("out_entry", "add"), lockFuidForOutEntry);

router.post("/verify-box", authenticate, accessControl("out_entry", "view"), verifyBoxSticker);

router.post("/batch-scan-boxes", authenticate, accessControl("out_entry", ["view", "add", "edit", "authorize"]), batchScanOutEntryBoxes);

// Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getOutEntriesViews);
router.post("/reason-helper", authenticate, accessControl("out_entry", "view"), getOutEntryReasonsViews);

export default router;
