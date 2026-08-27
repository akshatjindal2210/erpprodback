import express from "express";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { approveGateEntry, deleteGateEntry, getGateDetails, listGateEntries, listPendingGateEntries, saveGateEntry, scanGateBill } from "../controllers/gateEntry.controller.js";

const router = express.Router();

router.post("/pending", authenticate, accessControl("gate_entry", "view"), listPendingGateEntries);
router.post("/list", authenticate, accessControl("gate_entry", "view"), listGateEntries);
router.post("/details", authenticate, accessControl("gate_entry", "view"), getGateDetails);
router.post("/scan", authenticate, accessControl("gate_entry", ["view", "add"]), scanGateBill);
router.post("/save", authenticate, accessControl("gate_entry", ["add", "edit"]), saveGateEntry);
router.post("/approve", authenticate, accessControl("gate_entry", ["add", "edit", "authorize"]), approveGateEntry);
router.post("/delete", authenticate, accessControl("gate_entry", "delete"), deleteGateEntry);

export default router;
