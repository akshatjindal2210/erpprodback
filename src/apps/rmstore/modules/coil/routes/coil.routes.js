import express from "express";
import { getCoils, getCoilByUid } from "../controllers/coil.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_coils";

router.post("/list", authenticate, accessControl(MODULE, "view"), getCoils);
router.post("/get", authenticate, accessControl(MODULE, "view"), getCoilByUid);

export default router;
