import express from "express";
import { getInProcessRequests, getInProcessRequestById, getInProcessReasons, getCoilHelper, getPendingStoreIn, getPendingStoreInById, getPendingStoreOut, getPendingShopFloor, createInProcessRequest, updateInProcessRequestCtrl, completeStoreInCtrl, deleteInProcessRequest } from "../controllers/inProcessRequest.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl, accessControlAny } from "../../../../core/lib/middleware/accessControl.js";
import { rmIprUpload } from "../../../lib/middleware/upload.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();
const MODULE = "rm_in_process_request";

/** Pending queues render inside Store In / Store Out, so those modules may read them too. */
const storeInReader = accessControlAny([
  { moduleName: MODULE, actions: "view" },
  { moduleName: "rm_inventory_inwards", actions: "view" },
  { moduleName: "rm_inventory_inwards", actions: "add" },
]);
const storeOutReader = accessControlAny([
  { moduleName: MODULE, actions: "view" },
  { moduleName: "rm_out_entry", actions: "view" },
]);

/** Store In receive — Unassigned Area (Store In module add only). */
const storeInReceiver = accessControlAny([{ moduleName: "rm_inventory_inwards", actions: "add" }]);

router.post("/coil-helper", authenticate, accessControl(MODULE, "view"), getCoilHelper);
router.post("/list", authenticate, accessControl(MODULE, "view"), getInProcessRequests);
router.post("/get", authenticate, accessControl(MODULE, "view"), getInProcessRequestById);
router.post("/reasons", authenticate, accessControl(MODULE, "view"), getInProcessReasons);
router.post("/pending-shop-floor", authenticate, accessControl(MODULE, "view"), getPendingShopFloor);
router.post("/pending-store-in", authenticate, storeInReader, getPendingStoreIn);
router.post("/pending-store-in/get", authenticate, storeInReader, getPendingStoreInById);
router.post("/pending-store-out", authenticate, storeOutReader, getPendingStoreOut);
router.post("/create", authenticate, accessControl(MODULE, "add"), rmIprUpload.array("attachments"), createInProcessRequest);
router.post("/update", authenticate, accessControl(MODULE, "edit"), rmIprUpload.array("attachments"), updateInProcessRequestCtrl);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), rmIprUpload.array("attachments"), updateInProcessRequestCtrl);
router.post("/complete-store-in", authenticate, storeInReceiver, completeStoreInCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteInProcessRequest);

router.post("/helper", authenticate, helperAccess("inProcessRequest"), getInProcessRequestById);

export default router;
