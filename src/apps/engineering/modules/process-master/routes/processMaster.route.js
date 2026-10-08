import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";
import { listProcesses, getProcess, createProcess, updateProcess, deleteProcess, listProcessViews } from "../controllers/processMaster.controller.js";

const router = Router();
const M = "eng_process_master";

router.post("/list", authenticate, accessControl(M, "view"), listProcesses);
router.post("/get", authenticate, accessControl(M, "view"), getProcess);
router.post("/helper", authenticate, helperAccess("processMaster"), listProcessViews);
router.post("/create", authenticate, accessControl(M, "add"), createProcess);
router.post("/update", authenticate, accessControl(M, ["edit", "authorize"]), updateProcess);
router.post("/delete", authenticate, accessControl(M, "delete"), deleteProcess);

export default router;
