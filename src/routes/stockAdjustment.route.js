import express from "express";
import { getAdjustments, getAdjustmentById, createAdjustment, updateAdjustment, deleteAdjustment, getStockAdjustmentsViews } from "../controllers/stockAdjustment.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("stock_adjustment", "view"), getAdjustments);
router.post("/get", authenticate, accessControl("stock_adjustment", "view"), getAdjustmentById);
router.post("/create", authenticate, accessControl("stock_adjustment", "add"), createAdjustment);
router.post("/update", authenticate, accessControl("stock_adjustment", ["edit", "authorize"]), updateAdjustment);
router.post("/delete", authenticate, accessControl("stock_adjustment", "delete"), deleteAdjustment);

// Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getStockAdjustmentsViews);

export default router;