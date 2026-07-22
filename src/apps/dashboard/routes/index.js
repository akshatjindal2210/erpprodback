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
router.post("/widgets/list", superAdminOnly, dashboardController.listWidgetsHandler);
router.post("/widgets", superAdminOnly, dashboardController.createWidgetHandler);
router.put("/widgets/:id", superAdminOnly, dashboardController.updateWidgetHandler);
router.delete("/widgets/:id", superAdminOnly, dashboardController.deleteWidgetHandler);
router.post("/widgets/:id/publish", superAdminOnly, dashboardController.publishWidgetHandler);
router.post("/widgets/:id/unpublish", superAdminOnly, dashboardController.unpublishWidgetHandler);
router.get("/widgets/preview", superAdminOnly, dashboardController.previewWidgetHandler);
router.post("/widgets/preview", superAdminOnly, dashboardController.previewWidgetHandler);
router.post("/widgets/hybrid-preview", superAdminOnly, dashboardController.hybridPreviewHandler);
router.post("/configs/save-draft", superAdminOnly, dashboardController.saveDashboardDraftHandler);
router.post("/configs/publish", superAdminOnly, dashboardController.publishDashboardConfigHandler);
router.post("/configs/unpublish", superAdminOnly, dashboardController.unpublishDashboardConfigHandler);
router.post("/configs/delete", superAdminOnly, dashboardController.deleteDashboardConfigHandler);
router.post("/configs/clone-users", superAdminOnly, dashboardController.cloneDashboardToUsersHandler);
router.post("/configs/list", superAdminOnly, dashboardController.listDashboardConfigsHandler);
router.post("/configs/rename", superAdminOnly, dashboardController.renameDashboardConfigHandler);

// Dashboard render API (permission-filtered for logged in user)
router.get("/dashboard/user-dashboards", dashboardController.getUserDashboardsHandler);
router.post("/dashboard/user-dashboards", dashboardController.getUserDashboardsHandler);
router.get("/dashboard/status", dashboardController.getDashboardStatusHandler);
router.post("/dashboard/status", dashboardController.getDashboardStatusHandler);
router.get("/dashboard/widgets", dashboardController.getDashboardWidgetsHandler);
router.post("/dashboard/widgets", dashboardController.getDashboardWidgetsHandler);

export default router;
