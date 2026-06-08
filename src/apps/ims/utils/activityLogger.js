import ActivityLog from "../../core/models/activityLog.model.js";
import { buildActivityLogPayload } from "../../core/utils/activityLogPayload.js";

export const logActivity = async (
  req,
  {
    action,
    entity,
    entity_id = null,
    record = null,
    details = {},
    meta = null,
    success = true,
    userId = null,
    appType = "ims",
  }
) => {
  try {
    if (req) req._activityLogged = true;

    const { description, log_data, entity_id: numericEntityId } = buildActivityLogPayload({
      action,
      entity,
      entity_id,
      record,
      details,
      meta,
    });

    log_data.success = success;

    await ActivityLog.create({
      user_id: userId || req?.user?.id || null,
      app_type: appType,
      module: entity,
      action_type: String(action).toUpperCase(),
      description,
      log_data,
      ip_address: req?.ip || req?.headers?.["x-forwarded-for"] || null,
      user_agent: req?.headers?.["user-agent"] || null,
      entity,
      entity_id: numericEntityId,
    });
  } catch (err) {
    console.error("Activity log error:", err.message);
  }
};
