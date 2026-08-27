import express from "express";
import * as dashboardController from "../modules/dashboard/controllers/dashboard.controller.js";
import { authenticate } from "../../core/lib/middleware/auth.js";
import { superAdminOnly } from "../../core/lib/middleware/accessControl.js";

const router = express.Router();

router.use(authenticate);

// Super Admin widget builder APIs (POST only)
router.post("/tables", superAdminOnly, dashboardController.getTables);
router.post("/widgets/list", superAdminOnly, dashboardController.listWidgetsHandler);
router.post("/widgets", superAdminOnly, dashboardController.createWidgetHandler);
router.post("/widgets/update", superAdminOnly, dashboardController.updateWidgetHandler);
router.post("/widgets/delete", superAdminOnly, dashboardController.deleteWidgetHandler);
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
router.post("/dashboard/user-dashboards", dashboardController.getUserDashboardsHandler);
router.post("/dashboard/status", dashboardController.getDashboardStatusHandler);
router.post("/dashboard/filter-users", dashboardController.getDashboardFilterUsersHandler);
router.post("/dashboard/widgets", dashboardController.getDashboardWidgetsHandler);

export default router;
