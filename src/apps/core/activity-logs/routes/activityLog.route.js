import express from "express";
import { getActivityLogs } from "../controllers/activityLog.controller.js";
import { authenticate } from "../../lib/middleware/auth.js";
import { accessControl } from "../../lib/middleware/accessControl.js";

const LOG_MODULE_BY_APP = {
  ims: "activity_logs",
  rmstore: "rm_activity_logs",
  hrms: "hrms_activity_logs",
  purchase: "purchase_activity_logs",
  production: "production_activity_logs",
  task: "activity_logs",
};

/** app_type query → existing accessControl (no duplicate permission logic). */
function activityLogViewAccess(req, res, next) {
  const mod = LOG_MODULE_BY_APP[String(req.query?.app_type || "").toLowerCase()];
  if (!mod) return next();
  return accessControl(mod, "view")(req, res, next);
}

const router = express.Router();

router.get("/", authenticate, activityLogViewAccess, getActivityLogs);

export default router;
