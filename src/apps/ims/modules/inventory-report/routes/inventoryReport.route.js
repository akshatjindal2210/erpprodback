import express from "express";
import { getInventoryReport } from "../controllers/inventoryReport.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("inventory_report", "view"), getInventoryReport);

export default router;
