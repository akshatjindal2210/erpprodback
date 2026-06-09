import { Router } from "express";

import categoryRoutes from "./category.route.js";
import masterRoutes from "./master.routes.js";
import locationRoutes from "./locationMaster.routes.js";
import packingStandardRoutes from "./packingStandard.route.js";
import boxRoutes from "./box.route.js";
import inventoryInwardRoutes from "./inventoryInward.route.js";
import forwardingNoteRoutes from "./forwardingNote.route.js";
import outEntryRoutes from "./outEntry.route.js";
import stockAdjustmentRoutes from "./stockAdjustment.route.js";
import transactionBoxRoutes from "./transactionBox.routes.js";
import inventoryReportRoutes from "./inventoryReport.route.js";
import appConfigRoutes from "./appConfig.route.js";
import auditRoutes from "./audit.routes.js";

const router = Router();

router.use("/category", categoryRoutes);
router.use("/master", masterRoutes);
router.use("/locations", locationRoutes);
router.use("/packing-standard", packingStandardRoutes);
router.use("/boxes", boxRoutes);
router.use("/inventory-inwards", inventoryInwardRoutes);
router.use("/forwarding-notes", forwardingNoteRoutes);
router.use("/out-entries", outEntryRoutes);
router.use("/stock-adjustment", stockAdjustmentRoutes);
router.use("/box-transaction-logs", transactionBoxRoutes);
router.use("/inventory-report", inventoryReportRoutes);
router.use("/app-config", appConfigRoutes);
router.use("/audit", auditRoutes);

export default router;
