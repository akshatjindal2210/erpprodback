import { Router } from "express";

import categoryRoutes from "../modules/category/routes/category.route.js";
import masterRoutes from "../modules/master/routes/master.routes.js";
import locationRoutes from "../modules/location/routes/locationMaster.routes.js";
import packingStandardRoutes from "../modules/packing-standard/routes/packingStandard.route.js";
import boxRoutes from "../modules/box/routes/box.route.js";
import inventoryInwardRoutes from "../modules/inventory-inward/routes/inventoryInward.route.js";
import forwardingNoteRoutes from "../modules/forwarding-note/routes/forwardingNote.route.js";
import outEntryRoutes from "../modules/out-entry/routes/outEntry.route.js";
import stockAdjustmentRoutes from "../modules/stock-adjustment/routes/stockAdjustment.route.js";
import transactionBoxRoutes from "../manage/log/routes/transactionBox.routes.js";
import inventoryReportRoutes from "../modules/inventory-report/routes/inventoryReport.route.js";
import erpStockReportRoutes from "../modules/erp-stock-report/routes/erpStockReport.route.js";
import schedulePlanningRoutes from "../modules/schedule-planning/routes/schedulePlanning.route.js";
import appConfigRoutes from "../manage/app-config/routes/appConfig.route.js";
import auditRoutes from "../modules/audit/routes/audit.routes.js";
import qcHoldMaterialRoutes from "../modules/qc-hold-material/routes/qcHoldMaterial.routes.js";

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
router.use("/erp-stock-report", erpStockReportRoutes);
router.use("/schedule-planning", schedulePlanningRoutes);
router.use("/app-config", appConfigRoutes);
router.use("/audit", auditRoutes);
router.use("/qc-hold-material", qcHoldMaterialRoutes);

export default router;
