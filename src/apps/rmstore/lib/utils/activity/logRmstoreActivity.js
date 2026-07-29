import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";

/** Activity logs for RM Store — always stored with `app_type = rmstore`. */
export function logRmstoreActivity(req, options = {}) {
  return logActivity(req, { ...options, appType: "rmstore" });
}
