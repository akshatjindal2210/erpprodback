import express from "express";
import { getRmProducts, getRmProductById, getRmProductsViews } from "../controllers/rmProductMaster.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();
const MODULE = "rm_product_master";

router.post("/list", authenticate, accessControl(MODULE, "view"), getRmProducts);
router.post("/get", authenticate, accessControl(MODULE, "view"), getRmProductById);
router.post("/helper", authenticate, helperAccess("rmProducts"), getRmProductsViews);

export default router;
