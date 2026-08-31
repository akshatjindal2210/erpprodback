import express from "express";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { deleteGateEntry, getGateDetails, listGateEntries, listPendingGateEntries, openGateBill, saveGateEntry, updateGateEntry } from "../controllers/gateEntry.controller.js";

const router = express.Router();

router.post("/pending", authenticate, accessControl("gate_entry", "view"), listPendingGateEntries);
router.post("/list", authenticate, accessControl("gate_entry", "view"), listGateEntries);
router.post("/open", authenticate, accessControl("gate_entry", ["view", "add"]), openGateBill);
router.post("/details", authenticate, accessControl("gate_entry", "view"), getGateDetails);
router.post("/save", authenticate, accessControl("gate_entry", ["add", "edit"]), saveGateEntry);
router.post("/update", authenticate, accessControl("gate_entry", "edit"), updateGateEntry);
router.post("/delete", authenticate, accessControl("gate_entry", "delete"), deleteGateEntry);

export default router;
