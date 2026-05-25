import express from "express";
import { getForwardingNotes, getForwardingNoteById, createForwardingNote, updateForwardingNote, updateForwardingNoteBill, deleteForwardingNote, getAvailableBoxesByItem, getForwardingNoteItems, lockForwardingNoteLock, unlockForwardingNoteLock, getForwardingNotesViews, getForwardingNoteViewById, printForwardingNoteBill, getForwardingNoteTransportersViews } from "../controllers/forwardingNote.controller.js";

import { authenticate, authorize } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

// List
router.post("/list", authenticate, accessControl("forwarding_note_master", "view"), getForwardingNotes);

// List Item-wise
router.post("/list-items", authenticate, accessControl("forwarding_note_master", "view"), getForwardingNoteItems);

// Get single
router.post("/get", authenticate, accessControl("forwarding_note_master", "view"), getForwardingNoteById);

// Printable bill (HTML → user prints or saves as PDF)
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

// Super-admin manual lock / unlock for Out Entry lock
router.post("/lock-lock", authenticate, authorize("super_admin"), lockForwardingNoteLock);
router.post("/unlock-lock", authenticate, authorize("super_admin"), unlockForwardingNoteLock);

// Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getForwardingNotesViews);
// Transporter suggestions from past forwarding notes (helper)
router.post("/transporter-helper", authenticate, accessControl("forwarding_note_master", "view"), getForwardingNoteTransportersViews);
// router.post("/view-get", authenticate, getForwardingNoteViewById);

export default router;