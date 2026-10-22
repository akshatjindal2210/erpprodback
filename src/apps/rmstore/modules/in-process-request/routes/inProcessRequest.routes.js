import express from "express";
import { getInProcessRequests, getInProcessRequestById, getInProcessReasons, getCoilHelper, getReassignJobCards, getPendingStoreIn, getPendingStoreInById, getPendingStoreOut, getPendingShopFloor, createInProcessRequest, updateInProcessRequestCtrl, completeStoreInCtrl, deleteInProcessRequest } from "../controllers/inProcessRequest.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { docUpload } from "../../../../../lib/documents/index.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();
export const MODULE = "rm_in_process_request";

router.post("/coil-helper", authenticate, accessControl(MODULE, "view"), getCoilHelper);
router.post("/reassign-job-cards", authenticate, accessControl(MODULE, "view"), getReassignJobCards);
router.post("/list", authenticate, accessControl(MODULE, "view"), getInProcessRequests);
router.post("/get", authenticate, accessControl(MODULE, "view"), getInProcessRequestById);
router.post("/reasons", authenticate, accessControl(MODULE, "view"), getInProcessReasons);
router.post("/pending-shop-floor", authenticate, accessControl(MODULE, "view"), getPendingShopFloor);
router.post("/pending-store-out", authenticate, accessControl(MODULE, "view"), getPendingStoreOut);
router.post("/create", authenticate, accessControl(MODULE, "add"), docUpload(MODULE).array("attachments"), createInProcessRequest);
router.post("/update", authenticate, accessControl(MODULE, "edit"), docUpload(MODULE).array("attachments"), updateInProcessRequestCtrl);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), docUpload(MODULE).array("attachments"), updateInProcessRequestCtrl);
router.post("/complete-store-in", authenticate, accessControl("rm_inventory_inwards", "add"), completeStoreInCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteInProcessRequest);

router.post("/helper", authenticate, helperAccess("inProcessRequest"), getInProcessRequestById);
router.post("/pending-store-in", authenticate, helperAccess("inProcessRequest"), getPendingStoreIn);
router.post("/pending-store-in/get", authenticate, helperAccess("inProcessRequest"), getPendingStoreInById);

export default router;
