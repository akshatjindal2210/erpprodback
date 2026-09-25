import ActivityLog from "../../../apps/core/activity-logs/models/activityLog.model.js";
import { buildActivityLogPayload } from "./activityLogPayload.js";
import { scheduleNotifyFromActivity } from "../../../apps/core/notifications/templates/moduleNotify.service.js";

export const logActivity = async (req, {action, entity, entity_id = null, record = null, details = {}, meta = null, success = true, userId = null, appType = "ims", responseData = null }) => {
  try {
    if (req) req._activityLogged = true;

    const { description, log_data, entity_id: resolvedEntityId, entity_ref } = buildActivityLogPayload({action, entity, entity_id, record, details, meta});

    log_data.success = success;

    const storedEntityId = entity_ref != null && String(entity_ref).trim() !== "" ? String(entity_ref).trim() : resolvedEntityId != null ? String(resolvedEntityId) : null;

    await ActivityLog.create({
      user_id: userId || req?.user?.id || null,
      user_name: req?.user?.name || null,
      app_type: appType,
      module: entity,
      action_type: String(action).toUpperCase(),
      description,
      log_data,
      ip_address: req?.ip || req?.headers?.["x-forwarded-for"] || null,
      user_agent: req?.headers?.["user-agent"] || null,
      entity,
      entity_id: storedEntityId,
    });

    // Module notifications: see moduleNotify.service.js (MODULE_NOTIFY_FROM_ACTIVITY).
    
    // console.log("[Notoification Log] : ",{ action, entity, entity_id: storedEntityId, record, body: details, meta, log_data, responseData: responseData ?? record, appType, success });

    try {
      scheduleNotifyFromActivity(req, {
        action,
        entity,
        entity_id: storedEntityId,
        record,
        body: details,
        meta,
        log_data,
        responseData: responseData ?? record,
        appType,
        success,
      });
    } catch (notifyErr) {
      console.error("[Module notify] after activity log:", notifyErr.message);
    }
  } catch (err) {
    console.error("Activity log error:", err.message);
  }
};
