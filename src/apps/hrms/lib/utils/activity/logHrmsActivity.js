import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";

/** Activity logs for HRMS — always stored with `app_type = hrms`. */
export function logHrmsActivity(req, options = {}) {
  return logActivity(req, { ...options, appType: "hrms" });
}

/** Per-module logger — fire-and-forget; never throws. */
export function createHrmsActivityLogger(entity) {
  return (req, action, entity_id, details, record = null) =>
    logHrmsActivity(req, { action, entity, entity_id, details, record }).catch(() => {});
}
