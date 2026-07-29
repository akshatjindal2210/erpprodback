import express from "express";
import {
  getQcRejections,
  getQcRejectionById,
  createQcRejection,
  registerQcRejectionFromCheck,
  generateStoreOutFromQcCheck,
  updateQcRejectionBill,
  getQcRejectionBillNumbersViews,
  deleteQcRejection,
} from "../controllers/qcRejection.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_qc_rejection";

router.post("/list", authenticate, accessControl(MODULE, "view"), getQcRejections);
router.post("/get", authenticate, accessControl(MODULE, "view"), getQcRejectionById);
router.post("/create", authenticate, accessControl(MODULE, "add"), createQcRejection);
router.post("/register-from-check", authenticate, accessControl(MODULE, "add"), registerQcRejectionFromCheck);
router.post("/generate-store-out", authenticate, accessControl(MODULE, "add"), generateStoreOutFromQcCheck);
router.post("/update-bill", authenticate, accessControl(MODULE, "add"), updateQcRejectionBill);
router.post("/bill-helper", authenticate, accessControl(MODULE, "view"), getQcRejectionBillNumbersViews);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteQcRejection);

export default router;
