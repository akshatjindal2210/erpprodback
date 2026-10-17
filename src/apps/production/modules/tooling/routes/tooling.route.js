import express from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { deleteToolingRegister, getToolingList, saveToolingDecision } from "../controllers/tooling.controller.js";

const router = express.Router();
const MOD = "production_tooling";

router.post("/list", authenticate, accessControl(MOD, "view"), getToolingList);
router.post("/save", authenticate, accessControl(MOD, "authorize"), saveToolingDecision);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deleteToolingRegister);

export default router;
