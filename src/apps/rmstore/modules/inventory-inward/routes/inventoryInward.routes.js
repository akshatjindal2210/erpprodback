import express from "express";
import { getInwards, getPackingAreaList, getCoilAreaList, getInwardById, createInward, updateInwardCtrl, deleteInward } from "../controllers/inventoryInward.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_inventory_inwards";

router.post("/list", authenticate, accessControl(MODULE, "view"), getInwards);
router.post("/packing-area-list", authenticate, accessControl(MODULE, "view"), getPackingAreaList);
router.post("/coil-area-list", authenticate, accessControl(MODULE, "view"), getCoilAreaList);
router.post("/get", authenticate, accessControl(MODULE, "view"), getInwardById);
router.post("/create", authenticate, accessControl(MODULE, "add"), createInward);
router.post("/update", authenticate, accessControl(MODULE, ["edit", "authorize"]), updateInwardCtrl);
router.post("/approve", authenticate, accessControl(MODULE, "authorize"), updateInwardCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteInward);

export default router;
