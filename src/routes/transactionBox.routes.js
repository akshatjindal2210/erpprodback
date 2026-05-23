import express from "express";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../middleware/accessControl.js";
import { listTransactionBoxes } from "../controllers/transactionBox.controller.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("box_transaction_logs", "view"), listTransactionBoxes);

export default router;
