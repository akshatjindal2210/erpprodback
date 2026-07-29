import { Router } from "express";
import storeLocationRoutes from "../modules/store-location/routes/storeLocationMaster.routes.js";
import productionRoutes from "../modules/production/routes/productionMaster.routes.js";
import specRoutes from "../modules/spec/routes/specMaster.routes.js";
import mrnRoutes from "../modules/mrn/routes/mrn.routes.js";
import coilRoutes from "../modules/coil/routes/coil.routes.js";
import inventoryInwardRoutes from "../modules/inventory-inward/routes/inventoryInward.routes.js";
import qcCheckRoutes from "../modules/qc-check/routes/qcCheck.routes.js";
import qcRejectionRoutes from "../modules/qc-rejection/routes/qcRejection.routes.js";
import issueRequestRoutes from "../modules/issue-request/routes/issueRequest.routes.js";
import inProcessRequestRoutes from "../modules/in-process-request/routes/inProcessRequest.routes.js";
import outEntryRoutes from "../modules/out-entry/routes/outEntry.routes.js";
import inventoryReportRoutes from "../modules/inventory-report/routes/inventoryReport.routes.js";
import stockAdjustmentRoutes from "../modules/stock-adjustment/routes/stockAdjustment.routes.js";
import coilLogRoutes from "../manage/log/routes/coilLog.routes.js";

const router = Router();

router.use("/store-locations", storeLocationRoutes);
router.use("/production", productionRoutes);
router.use("/spec", specRoutes);
router.use("/mrn", mrnRoutes);
router.use("/coils", coilRoutes);
router.use("/inventory-inwards", inventoryInwardRoutes);
router.use("/qc-checks", qcCheckRoutes);
router.use("/qc-rejections", qcRejectionRoutes);
router.use("/issue-requests", issueRequestRoutes);
router.use("/in-process-requests", inProcessRequestRoutes);
router.use("/out-entries", outEntryRoutes);
router.use("/stock-adjustment", stockAdjustmentRoutes);
router.use("/inventory-report", inventoryReportRoutes);
router.use("/logs", coilLogRoutes);

export default router;
