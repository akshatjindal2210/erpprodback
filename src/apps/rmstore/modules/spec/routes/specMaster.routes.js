import express from "express";
import { getSpecs, getSpecById, createSpec, updateSpec, deleteSpec } from "../controllers/specMaster.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_spec_master";

router.post("/list", authenticate, accessControl(MODULE, "view"), getSpecs);
router.post("/get", authenticate, accessControl(MODULE, "view"), getSpecById);
router.post("/create", authenticate, accessControl(MODULE, "add"), createSpec);
router.post("/update", authenticate, accessControl(MODULE, ["edit", "authorize"]), updateSpec);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteSpec);

export default router;
