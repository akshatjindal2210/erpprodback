import express from "express";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControlAny } from "../../../../core/lib/middleware/accessControl.js";
import { listTransactionBoxes } from "../controllers/transactionBox.controller.js";

const router = express.Router();

router.post("/list", authenticate, accessControlAny([
    { moduleName: "box_transaction_logs", actions: "view" },
    { moduleName: "boxes", actions: "view" },
  ]),
  listTransactionBoxes
);

export default router;
