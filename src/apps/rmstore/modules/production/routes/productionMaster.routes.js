import express from "express";
import { getProductions, getProductionById, createProduction, updateProduction, deleteProduction } from "../controllers/productionMaster.controller.js";
import { getProductionItemsViews, getRmItemsViews, getPrdRunJcViews } from "../controllers/productionErpHelpers.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();
const MODULE = "rm_production_master";

router.post("/list", authenticate, accessControl(MODULE, "view"), getProductions);
router.post("/get", authenticate, accessControl(MODULE, "view"), getProductionById);
router.post("/create", authenticate, accessControl(MODULE, "add"), createProduction);
router.post("/update", authenticate, accessControl(MODULE, ["edit", "authorize"]), updateProduction);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteProduction);

router.post("/production-items/helper", authenticate, helperAccess("productionItems"), getProductionItemsViews);
router.post("/rm-items/helper", authenticate, helperAccess("rmItems"), getRmItemsViews);
router.post("/prd-run-jc/helper", authenticate, helperAccess("prdRunJc"), getPrdRunJcViews);

export default router;
