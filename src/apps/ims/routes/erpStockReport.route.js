import express from "express";
import { getErpStockComparisonReport } from "../controllers/erpStockReport.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../../core/middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("erp_stock_report", "view"), getErpStockComparisonReport);

export default router;
