import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { listPrimeProcesses, getProductionById, savePrimeProcess, clearPrimeProcess } from "../../../../rmstore/modules/production/controllers/productionMaster.controller.js";
import { getProductionItemsViews, getRmItemsViews } from "../../../../rmstore/modules/production/controllers/productionErpHelpers.controller.js";
import { helperAccess } from "../../../../rmstore/lib/config/views/helperViews.js";

/** Prime Process Master — same table; only reads/writes `prime_process` JSON (no RM approve/audit). */
const router = Router();
const M = "eng_prime_item_master";

router.post("/list", authenticate, accessControl(M, "view"), listPrimeProcesses);
router.post("/get", authenticate, accessControl(M, "view"), getProductionById);
router.post("/create", authenticate, accessControl(M, "add"), savePrimeProcess);
router.post("/update", authenticate, accessControl(M, "edit"), savePrimeProcess);
router.post("/delete", authenticate, accessControl(M, "delete"), clearPrimeProcess);

/** Same production-item dropdown as Item RM Master (`prdprimitem`). */
router.post("/production-items/helper", authenticate, helperAccess("productionItems"), getProductionItemsViews);
router.post("/rm-items/helper", authenticate, helperAccess("rmItems"), getRmItemsViews);

export default router;
