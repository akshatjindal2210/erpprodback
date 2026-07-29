import { Router } from "express";
import userCoreRoutes from "../identity/users/routes/user.route.js";
import trainingRoutes from "../training/videos/trainingVideo.routes.js";
import sopRoutes from "../training/sops/moduleSop.routes.js";
import moduleRoutes from "../identity/modules/routes/module.route.js";
import permissionRoutes from "../identity/permissions/routes/permission.route.js";
import departmentRoutes from "../identity/departments/routes/department.route.js";
import designationRoutes from "../identity/designations/routes/designation.route.js";
import activityLogRoutes from "../activity-logs/routes/activityLog.route.js";
import inboxRoutes from "../notifications/inbox/inbox.route.js";
import pushRoutes from "../notifications/push/push.route.js";
// import userAppPreferenceRoutes from "../configuration/routes/userAppPreference.route.js";

const router = Router();

router.use("/auth", userCoreRoutes);
router.use("/auth/modules", moduleRoutes);
router.use("/auth/permissions", permissionRoutes);
router.use("/auth/departments", departmentRoutes);
router.use("/auth/designations", designationRoutes);
router.use("/activity-logs", activityLogRoutes);
router.use("/inbox", inboxRoutes);
router.use("/push", pushRoutes);
// router.use("/user-preferences", userAppPreferenceRoutes);
router.use("/training", trainingRoutes);
router.use("/sop", sopRoutes);

export default router;
