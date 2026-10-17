import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { fgProcess } from "../../item-process/controllers/itemProcess.controller.js";
import { getFgItemsViews, getRmItemsViews } from "../../../../rmstore/modules/production/controllers/productionErpHelpers.controller.js";
import { helperAccess } from "../../../../rmstore/lib/config/views/helperViews.js";

/** FG Process Master — eng_item_process type 2 (fg), on its prime item's prime. No Item RM (rmstore) link. */
const router = Router();
const M = "eng_finish_process_master";

router.post("/list", authenticate, accessControl(M, "view"), fgProcess.list);
router.post("/get", authenticate, accessControl(M, "view"), fgProcess.get);
router.post("/create", authenticate, accessControl(M, "add"), fgProcess.save);
router.post("/update", authenticate, accessControl(M, "edit"), fgProcess.save);
router.post("/delete", authenticate, accessControl(M, "delete"), fgProcess.remove);

/** FG item dropdown — IMS item master `{ type: "fg" }`; RM dropdown — IMS RM items. */
router.post("/production-items/helper", authenticate, helperAccess("productionItems"), getFgItemsViews);
router.post("/rm-items/helper", authenticate, helperAccess("rmItems"), getRmItemsViews);

export default router;
