import express from "express";
import { getOutEntries, getPendingStoreOutList, getStoredMrnList, getStoredMrnDetail, getOutEntryById, createOutEntry, updateOutEntryCtrl, deleteOutEntry } from "../controllers/outEntry.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_out_entry";

router.post("/list", authenticate, accessControl(MODULE, "view"), getOutEntries);
router.post("/pending-list", authenticate, accessControl(MODULE, "view"), getPendingStoreOutList);
router.post("/stored-mrn-list", authenticate, accessControl(MODULE, "view"), getStoredMrnList);
router.post("/stored-mrn-detail", authenticate, accessControl(MODULE, "view"), getStoredMrnDetail);
router.post("/get", authenticate, accessControl(MODULE, "view"), getOutEntryById);
router.post("/create", authenticate, accessControl(MODULE, "add"), createOutEntry);
router.post("/update", authenticate, accessControl(MODULE, ["edit", "authorize"]), updateOutEntryCtrl);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), updateOutEntryCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteOutEntry);

export default router;
