import express from "express";
import { getCoils, getCoilByUid, getCoilsViews, printCoilFinderReport } from "../controllers/coil.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();
const MODULE = "rm_coils";

router.post("/list", authenticate, accessControl(MODULE, "view"), getCoils);
router.post("/get", authenticate, accessControl(MODULE, "view"), getCoilByUid);
router.post("/helper", authenticate, helperAccess("coils"), getCoilsViews);
router.post("/finder-report", authenticate, helperAccess("coils"), printCoilFinderReport);

export default router;
