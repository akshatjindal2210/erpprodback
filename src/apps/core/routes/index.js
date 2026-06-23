import { Router } from "express";
import userCoreRoutes from "./user.route.js";
import trainingRoutes from "./trainingVideo.routes.js";
import sopRoutes from "./moduleSop.routes.js";
import moduleRoutes from "./module.route.js";
import permissionRoutes from "./permission.route.js";
import departmentRoutes from "./department.route.js";
import designationRoutes from "./designation.route.js";
import activityLogRoutes from "./activityLog.route.js";
import inboxRoutes from "./inbox.route.js";
// import userAppPreferenceRoutes from "./userAppPreference.route.js";

const router = Router();

router.use("/auth", userCoreRoutes);
router.use("/auth/modules", moduleRoutes);
router.use("/auth/permissions", permissionRoutes);
router.use("/auth/departments", departmentRoutes);
router.use("/auth/designations", designationRoutes);
router.use("/activity-logs", activityLogRoutes);
router.use("/inbox", inboxRoutes);
// router.use("/user-preferences", userAppPreferenceRoutes);
router.use("/training", trainingRoutes);
router.use("/sop", sopRoutes);

export default router;
