import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";

/** Activity logs for RM Store — always stored with `app_type = rmstore`. */
export function logRmstoreActivity(req, options = {}) {
  return logActivity(req, { ...options, appType: "rmstore" });
}

/** Per-module logger — fire-and-forget; never throws. */
export function createRmstoreActivityLogger(entity) {
  return (req, action, entity_id, details, record = null) =>
    logRmstoreActivity(req, { action, entity, entity_id, details, record }).catch(() => {});
}
