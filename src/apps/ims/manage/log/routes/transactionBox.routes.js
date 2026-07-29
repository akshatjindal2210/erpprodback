import express from "express";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { listTransactionBoxes } from "../controllers/transactionBox.controller.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("box_transaction_logs", "view"), listTransactionBoxes);

export default router;
