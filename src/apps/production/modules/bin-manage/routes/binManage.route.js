import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";
import { getBinsViews } from "../../bin/controllers/binMaster.controller.js";
import { getProductionEntryJcPlan, listProductionEntryJcsByMachine } from "../../entry/controllers/entry.controller.js";
import * as ctrl from "../controllers/binManage.controller.js";

/** Production Bin Management — assign / transfer / relieve / location (PRD bins). */
const router = Router();
const M = "production_bin_manage";

router.post("/list", authenticate, accessControl(M, "view"), ctrl.list);
router.post("/get", authenticate, accessControl(M, "view"), ctrl.get);
router.post("/scan", authenticate, accessControl(M, "view"), ctrl.scan);
router.post("/assign", authenticate, accessControl(M, "add"), ctrl.assign);
router.post("/transfer", authenticate, accessControl(M, "add"), ctrl.transfer);
router.post("/relieve", authenticate, accessControl(M, "add"), ctrl.relieve);
router.post("/location", authenticate, accessControl(M, "add"), ctrl.location);
router.post("/update", authenticate, accessControl(M, "edit"), ctrl.update);
router.post("/delete", authenticate, accessControl(M, "delete"), ctrl.remove);

/** Same as entry helpers — ACL is bin_manage so Assign works without production_entry. */
router.post("/jc-plan", authenticate, accessControl(M, "view"), getProductionEntryJcPlan);
router.post("/jcs-by-machine", authenticate, accessControl(M, "view"), listProductionEntryJcsByMachine);

/** Bin picker from this page. */
router.post("/bins/helper", authenticate, helperAccess("bins"), getBinsViews);

export default router;
