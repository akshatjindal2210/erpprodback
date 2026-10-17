import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { primeProcess } from "../../item-process/controllers/itemProcess.controller.js";
import { getProductionItemsViews, getRmItemsViews } from "../../../../rmstore/modules/production/controllers/productionErpHelpers.controller.js";
import { helperAccess } from "../../../../rmstore/lib/config/views/helperViews.js";

/** Prime Process Master — eng_item_process type 1 (prime). No Item RM (rmstore) link. */
const router = Router();
const M = "eng_prime_item_master";

router.post("/list", authenticate, accessControl(M, "view"), primeProcess.list);
router.post("/get", authenticate, accessControl(M, "view"), primeProcess.get);
router.post("/create", authenticate, accessControl(M, "add"), primeProcess.save);
router.post("/update", authenticate, accessControl(M, "edit"), primeProcess.save);
router.post("/delete", authenticate, accessControl(M, "delete"), primeProcess.remove);

/** Prime item dropdown — IMS `prdprimitem`; RM dropdown — IMS RM items. */
router.post("/production-items/helper", authenticate, helperAccess("productionItems"), getProductionItemsViews);
router.post("/rm-items/helper", authenticate, helperAccess("rmItems"), getRmItemsViews);

export default router;
