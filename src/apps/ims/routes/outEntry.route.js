import express from "express";
import { getOutEntries, getOutEntryById, createOutEntry, updateOutEntry, deleteOutEntry, verifyBoxSticker, batchScanOutEntryBoxes, getFuidDetailsForOutEntry, getQcHoldDetailsForOutEntry, getOutEntryLinkedBoxesController, lockFuidForOutEntry, getOutEntriesViews, getOutEntryReasonsViews } from "../controllers/outEntry.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../../core/middleware/accessControl.js";
import { helperAccess } from "../config/helperViews.js";

const router = express.Router();

// List
router.post("/list", authenticate, accessControl("out_entry", "view"), getOutEntries);

// Get single
router.post("/get", authenticate, accessControl("out_entry", "view"), getOutEntryById);

// Create
router.post("/create", authenticate, accessControl("out_entry", "add"), createOutEntry);

// Update — add included so draft save (add) ke baad submit bhi same user kar sake
router.post("/update", authenticate, accessControl("out_entry", ["add", "edit", "authorize"]), updateOutEntry);

// Delete
router.post("/delete", authenticate, accessControl("out_entry", "delete"), deleteOutEntry);

// Get Forwarding Note details for Out Entry
router.post("/get-details", authenticate, accessControl("out_entry", "view"), getFuidDetailsForOutEntry);

router.post("/get-qc-hold-details", authenticate, accessControl("out_entry", "view"), getQcHoldDetailsForOutEntry);

router.post("/linked-boxes", authenticate, accessControl("out_entry", "view"), getOutEntryLinkedBoxesController);

router.post("/lock-fuid", authenticate, accessControl("out_entry", "add"), lockFuidForOutEntry);

router.post("/verify-box", authenticate, accessControl("out_entry", "view"), verifyBoxSticker);

router.post("/batch-scan-boxes", authenticate, accessControl("out_entry", ["view", "add", "edit", "authorize"]), batchScanOutEntryBoxes);

// Views (Helper API)
router.post("/helper", authenticate, helperAccess("outEntries"), getOutEntriesViews);
router.post("/reason-helper", authenticate, accessControl("out_entry", "view"), getOutEntryReasonsViews);

export default router;
