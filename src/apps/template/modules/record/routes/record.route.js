import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { listRecords, getRecord, createRecord, updateRecord, deleteRecord, helperRecords } from "../controllers/record.controller.js";

const router = Router();
const MODULE = "template_record";

router.post("/list", authenticate, accessControl(MODULE, "view"), listRecords);
router.post("/get", authenticate, accessControl(MODULE, "view"), getRecord);
router.post("/create", authenticate, accessControl(MODULE, "add"), createRecord);
router.post("/update", authenticate, accessControl(MODULE, ["edit", "authorize"]), updateRecord);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteRecord);
router.post("/helper", authenticate, accessControl(MODULE, "view"), helperRecords);

export default router;
