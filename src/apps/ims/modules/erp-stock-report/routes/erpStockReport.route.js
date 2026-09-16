import express from "express";
import { adjustErpStockMismatch, getErpStockComparisonReport } from "../controllers/erpStockReport.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("erp_stock_report", "view"), getErpStockComparisonReport);
router.post("/adjust", authenticate, accessControl("erp_stock_report", "view"), adjustErpStockMismatch);

export default router;
