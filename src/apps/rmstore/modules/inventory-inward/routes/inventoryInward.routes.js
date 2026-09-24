import express from "express";
import { getInwards, getPendingStoreInList, getPackingAreaList, getCoilAreaList, getInwardById, createInward, updateInwardCtrl, deleteInward } from "../controllers/inventoryInward.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl, accessControlAny } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_inventory_inwards";

/** Unassigned / pending reads — view or add (receive operators may have add without separate IPR access). */
const storeInPageReader = accessControlAny([
  { moduleName: MODULE, actions: "view" },
  { moduleName: MODULE, actions: "add" },
]);

router.post("/list", authenticate, accessControl(MODULE, "view"), getInwards);
router.post("/pending-list", authenticate, storeInPageReader, getPendingStoreInList);
router.post("/packing-area-list", authenticate, storeInPageReader, getPackingAreaList);
router.post("/coil-area-list", authenticate, storeInPageReader, getCoilAreaList);
router.post("/get", authenticate, accessControl(MODULE, "view"), getInwardById);
router.post("/create", authenticate, accessControl(MODULE, "add"), createInward);
router.post("/update", authenticate, accessControl(MODULE, ["edit", "authorize"]), updateInwardCtrl);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), updateInwardCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteInward);

export default router;
