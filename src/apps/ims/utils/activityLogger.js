import { createLog } from "../models/activityLog.model.js";

export const logActivity = async (
  req,
  { action, entity, entity_id = null, details = {}, success = true }
) => {
  try {
    await createLog({
      user_id: req.user?.id ?? null,
      user_type: req.user?.type ?? "user",
      action,
      entity,
      entity_id,
      details: { ...details, success },
      ip_address: req.ip || req.headers["x-forwarded-for"] || null,
      user_agent: req.headers["user-agent"] || null,
      created_by: req.user?.id ?? null,
    });
  } catch (err) {
    console.error("IMS activity log error:", err.message);
  }
};
