import express from "express";
import * as dashboardController from "../controllers/dashboard.controller.js";
import { authenticate } from "../../core/middleware/auth.js";
import { superAdminOnly } from "../../core/middleware/accessControl.js";

const router = express.Router();

router.use(authenticate);

// Super Admin widget builder APIs
router.get("/tables", superAdminOnly, dashboardController.getTables);
router.get("/columns/:table", superAdminOnly, dashboardController.getColumns);
router.get("/widgets", superAdminOnly, dashboardController.listWidgetsHandler);
router.post("/widgets", superAdminOnly, dashboardController.createWidgetHandler);
router.put("/widgets/:id", superAdminOnly, dashboardController.updateWidgetHandler);
router.delete("/widgets/:id", superAdminOnly, dashboardController.deleteWidgetHandler);
router.post("/widgets/:id/publish", superAdminOnly, dashboardController.publishWidgetHandler);
router.get("/widgets/preview", superAdminOnly, dashboardController.previewWidgetHandler);
router.post("/widgets/preview", superAdminOnly, dashboardController.previewWidgetHandler);

// Dashboard render API (permission-filtered for logged in user)
router.get("/dashboard/widgets", dashboardController.getDashboardWidgetsHandler);

export default router;
