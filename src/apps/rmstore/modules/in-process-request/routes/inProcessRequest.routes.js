import express from "express";
import { getInProcessRequests, getInProcessRequestById, getInProcessReasons, getPendingStoreIn, getPendingStoreOut, createInProcessRequest, updateInProcessRequestCtrl, completeStoreInCtrl, deleteInProcessRequest } from "../controllers/inProcessRequest.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl, accessControlAny } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_issue_request";

/** Pending queues render inside Store In / Store Out, so those modules may read them too. */
const storeInReader = accessControlAny([
  { moduleName: MODULE, actions: "view" },
  { moduleName: "rm_inventory_inwards", actions: "view" },
]);
const storeOutReader = accessControlAny([
  { moduleName: MODULE, actions: "view" },
  { moduleName: "rm_out_entry", actions: "view" },
]);

/** Store In receive — production (issue request) or store staff may complete. */
const storeInReceiver = accessControlAny([
  { moduleName: MODULE, actions: "authorize" },
  { moduleName: "rm_inventory_inwards", actions: "authorize" },
]);

router.post("/list", authenticate, accessControl(MODULE, "view"), getInProcessRequests);
router.post("/get", authenticate, accessControl(MODULE, "view"), getInProcessRequestById);
router.post("/reasons", authenticate, accessControl(MODULE, "view"), getInProcessReasons);
router.post("/pending-store-in", authenticate, storeInReader, getPendingStoreIn);
router.post("/pending-store-out", authenticate, storeOutReader, getPendingStoreOut);
router.post("/create", authenticate, accessControl(MODULE, "add"), createInProcessRequest);
router.post("/update", authenticate, accessControl(MODULE, "edit"), updateInProcessRequestCtrl);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), updateInProcessRequestCtrl);
router.post("/complete-store-in", authenticate, storeInReceiver, completeStoreInCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteInProcessRequest);

export default router;
