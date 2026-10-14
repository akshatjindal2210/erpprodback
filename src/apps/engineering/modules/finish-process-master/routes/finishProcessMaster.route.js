import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { listFinishProcesses, getProductionById, saveFinishProcess, clearFinishProcess } from "../../../../rmstore/modules/production/controllers/productionMaster.controller.js";
import { getFgItemsViews, getRmItemsViews } from "../../../../rmstore/modules/production/controllers/productionErpHelpers.controller.js";
import { helperAccess } from "../../../../rmstore/lib/config/views/helperViews.js";

/** Finish Process Master — same `rmstore_master_production` table; only `finish_process` JSON. */
const router = Router();
const M = "eng_finish_process_master";

router.post("/list", authenticate, accessControl(M, "view"), listFinishProcesses);
router.post("/get", authenticate, accessControl(M, "view"), getProductionById);
router.post("/create", authenticate, accessControl(M, "add"), saveFinishProcess);
router.post("/update", authenticate, accessControl(M, "edit"), saveFinishProcess);
router.post("/delete", authenticate, accessControl(M, "delete"), clearFinishProcess);

/** FG items (IMS `item` type=fg) — not prime production items. */
router.post("/production-items/helper", authenticate, helperAccess("productionItems"), getFgItemsViews);
router.post("/rm-items/helper", authenticate, helperAccess("rmItems"), getRmItemsViews);

export default router;
