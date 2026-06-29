import express from "express";
import { getForwardingNotes, getForwardingNoteById, createForwardingNote, updateForwardingNote, updateForwardingNoteBill, deleteForwardingNote, getAvailableBoxesByItem, getAvailableItemsForForwarding, getForwardingNoteItems, lockForwardingNoteLock, unlockForwardingNoteLock, getForwardingNotesViews, printForwardingNoteBill, getForwardingNoteTransportersViews, getForwardingNoteBillNumbersViews, getErpFgStockByItem, getForwardingNoteCustomerCategory } from "../controllers/forwardingNote.controller.js";

import { authenticate, authorize } from "../middleware/auth.js";
import { accessControl, accessControlAny } from "../../core/middleware/accessControl.js";
import { helperAccess } from "../config/helperViews.js";

const router = express.Router();

// List
router.post("/list", authenticate, accessControlAny([
  { moduleName: "forwarding_note_master", actions: "view" },
  { moduleName: "out_entry", actions: "view" }
]), getForwardingNotes);

// List Item-wise
router.post("/list-items", authenticate, accessControlAny([
  { moduleName: "forwarding_note_master", actions: "view" },
  { moduleName: "out_entry", actions: "view" }
]), getForwardingNoteItems);

// Get single
router.post("/get", authenticate, accessControlAny([
  { moduleName: "forwarding_note_master", actions: "view" },
  { moduleName: "out_entry", actions: "view" }
]), getForwardingNoteById);

// Printable bill (HTML ? user prints or saves as PDF)
router.post("/print-bill", authenticate, accessControl("forwarding_note_master", "view"), printForwardingNoteBill);

// Create
router.post("/create", authenticate, accessControl("forwarding_note_master", "add"), createForwardingNote);

// Update (allow both edit users and authorize users)
router.post("/update", authenticate, accessControl("forwarding_note_master", ["edit", "authorize"]), updateForwardingNote);

// Bill # only (works when locked for out entry)
router.post("/update-bill", authenticate, accessControl("forwarding_note_master", "edit"), updateForwardingNoteBill);

// Delete
router.post("/delete", authenticate, accessControl("forwarding_note_master", "delete"), deleteForwardingNote);

// Get available boxes for an item (for forwarding note creation)
router.post("/available-boxes", authenticate, accessControl("forwarding_note_master", "view"), getAvailableBoxesByItem);

// Items with dispatchable FG stock (forwarding note item dropdown)
router.post("/available-items", authenticate, accessControl("forwarding_note_master", "view"), getAvailableItemsForForwarding);

// ERP FG stock for item (internal API erpfg)
router.post("/erp-stock", authenticate, accessControl("forwarding_note_master", "view"), getErpFgStockByItem);

// Customer last category + all category options
router.post("/customer-category", authenticate, accessControl("forwarding_note_master", "view"), getForwardingNoteCustomerCategory);

// Super-admin manual lock / unlock for Out Entry lock
router.post("/lock-lock", authenticate, authorize("super_admin"), lockForwardingNoteLock);
router.post("/unlock-lock", authenticate, authorize("super_admin"), unlockForwardingNoteLock);

// Views (Helper API)
router.post("/helper", authenticate, helperAccess("forwardingNotes"), getForwardingNotesViews);

// Transporter suggestions from past forwarding notes (helper)
router.post("/transporter-helper", authenticate, accessControl("forwarding_note_master", "view"), getForwardingNoteTransportersViews);

// Bill numbers from live IMS (helper)
router.post("/bill-helper", authenticate, accessControl("forwarding_note_master", "view"), getForwardingNoteBillNumbersViews);

export default router;
