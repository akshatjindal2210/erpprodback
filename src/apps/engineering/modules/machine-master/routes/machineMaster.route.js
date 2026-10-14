import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { docUpload } from "../../../../../lib/documents/index.js";
import { listMachines, getMachine, createMachine, updateMachine, deleteMachine, listMachineViews, getMachineQr } from "../controllers/machineMaster.controller.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = Router();
const M = "eng_machine_master";

router.post("/list", authenticate, accessControl(M, "view"), listMachines);
router.post("/get", authenticate, accessControl(M, "view"), getMachine);
router.post("/qr", authenticate, accessControl(M, "view"), getMachineQr);
router.post("/create", authenticate, accessControl(M, "add"), docUpload(M).array("attachments", 20), createMachine);
router.post("/update", authenticate, accessControl(M, ["edit", "authorize"]), docUpload(M).array("attachments", 20), updateMachine);
router.post("/delete", authenticate, accessControl(M, "delete"), deleteMachine);
router.post("/helper", authenticate, helperAccess("machineMaster"), listMachineViews);

export default router;
