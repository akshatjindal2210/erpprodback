import express from "express";
import { getAdjustments, getAdjustmentById, createAdjustment, updateAdjustment, deleteAdjustment, getStockAdjustmentsViews, getStockAdjustmentPackingMeta } from "../controllers/stockAdjustment.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../../core/middleware/accessControl.js";
import { helperAccess } from "../config/helperViews.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("stock_adjustment", "view"), getAdjustments);
router.post("/get", authenticate, accessControl("stock_adjustment", "view"), getAdjustmentById);
router.post("/packing-meta", authenticate, accessControl("stock_adjustment", "view"), getStockAdjustmentPackingMeta);
router.post("/create", authenticate, accessControl("stock_adjustment", "add"), createAdjustment);
router.post("/update", authenticate, accessControl("stock_adjustment", ["edit", "authorize"]), updateAdjustment);
router.post("/delete", authenticate, accessControl("stock_adjustment", "delete"), deleteAdjustment);

router.post("/helper", authenticate, helperAccess("stockAdjustment"), getStockAdjustmentsViews);

export default router;
