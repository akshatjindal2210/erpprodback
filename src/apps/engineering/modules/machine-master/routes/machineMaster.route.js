import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { engineeringMachineUpload } from "../../../../ims/lib/middleware/upload.js";
import { listMachines, getMachine, createMachine, updateMachine, deleteMachine } from "../controllers/machineMaster.controller.js";

const router = Router();
const M = "eng_machine_master";

router.post("/list", authenticate, accessControl(M, "view"), listMachines);
router.post("/get", authenticate, accessControl(M, "view"), getMachine);
router.post("/create", authenticate, accessControl(M, "add"), engineeringMachineUpload.array("attachments", 20), createMachine);
router.post("/update", authenticate, accessControl(M, ["edit", "authorize"]), engineeringMachineUpload.array("attachments", 20), updateMachine);
router.post("/delete", authenticate, accessControl(M, "delete"), deleteMachine);

export default router;
