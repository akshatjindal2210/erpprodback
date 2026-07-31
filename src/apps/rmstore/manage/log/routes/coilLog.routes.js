import express from "express";
import { listCoilTransactionLogs, listCoilDownloadLog } from "../controllers/coilLog.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();

router.post("/coil-transactions/list", authenticate, accessControl("rm_coil_transaction_logs", "view"), listCoilTransactionLogs);
router.post("/sticker-downloads/list", authenticate, accessControl("rm_coil_download_logs", "view"), listCoilDownloadLog);

export default router;
