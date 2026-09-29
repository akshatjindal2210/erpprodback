import ActivityLog from "../../../apps/core/activity-logs/models/activityLog.model.js";
import { buildActivityLogPayload } from "./activityLogPayload.js";
import { scheduleNotifyFromActivity } from "../../../apps/core/notifications/templates/moduleNotify.service.js";
import { normalizeApprovedInput } from "../auth/approval.js";

const CRUD_ACTIONS = new Set(["create", "add", "insert", "update", "edit", "modify", "patch"]);

function isApprovedFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const n = value.trim().toLowerCase();
    return n === "true" || n === "1" || n === "approved";
  }
  return false;
}

function readIncomingApproved(req, explicit, details) {
  if (explicit !== undefined) return explicit;
  try {
    const b = req?.body;
    if (b?.approved !== undefined) return normalizeApprovedInput(b.approved);
    if (b?.approval_status !== undefined) return normalizeApprovedInput(b.approval_status);
  } catch {
    /* ignore invalid approval input on log path */
  }
  if (details && typeof details === "object") {
    if (details.approved !== undefined) return isApprovedFlag(details.approved);
    if (details.new_values?.approved !== undefined) return isApprovedFlag(details.new_values.approved);
  }
  return undefined;
}

function readPriorApproved({ ctx, existing, alreadyApproved, details, record }) {
  if (alreadyApproved !== undefined) return alreadyApproved === true;
  if (ctx?.alreadyApproved === true) return true;
  if (existing != null) return isApprovedFlag(existing.approved);
  if (details?.old_values?.approved !== undefined) return isApprovedFlag(details.old_values.approved);
  if (record != null && details?.approved !== undefined) return isApprovedFlag(record.approved);
  return false;
}

/** add / edit / delete / approve — driven by approval workflow context on `req` + optional log hints. */
export function resolveActivityLogAction({ action, req, existing, incomingApproved, alreadyApproved, details, record } = {}) {
  const act = String(action || "").trim().toLowerCase();
  if (!CRUD_ACTIONS.has(act)) return action;

  const ctx = req?._activityApprovalContext;
  if (ctx?.appliedApprove === true && ctx.incomingApproved === true) return "approve";

  const incoming = readIncomingApproved(req, incomingApproved, details);
  if (act === "create" || act === "add" || act === "insert") {
    return incoming === true ? "approve" : action;
  }

  const was = readPriorApproved({ ctx, existing, alreadyApproved, details, record });
  if (incoming === true && !was) {
    // Require proof of transition — avoid re-notify when body still has approved:true on an already-approved row.
    if (existing != null && !isApprovedFlag(existing.approved)) return "approve";
    if (alreadyApproved === false) return "approve";
    return action;
  }
  return action;
}

export const logActivity = async (req, opts = {}) => {

  const { action, entity, entity_id = null, record = null, details = {}, meta = null, success = true, userId = null, appType = "ims", responseData = null } = opts;

  try {
    if (req) req._activityLogged = true;

    const resolvedAction = resolveActivityLogAction({ action, req, existing: opts.existing, incomingApproved: opts.incomingApproved, alreadyApproved: opts.alreadyApproved, details, record: record ?? responseData });

    if (req?._activityApprovalContext) delete req._activityApprovalContext;

    const { description, log_data, entity_id: resolvedEntityId, entity_ref } = buildActivityLogPayload({action: resolvedAction, entity, entity_id, record, details, meta});

    log_data.success = success;

    const storedEntityId = entity_ref != null && String(entity_ref).trim() !== "" ? String(entity_ref).trim() : resolvedEntityId != null ? String(resolvedEntityId) : null;

    await ActivityLog.create({
      user_id: userId || req?.user?.id || null,
      user_name: req?.user?.name || null,
      app_type: appType,
      module: entity,
      action_type: String(resolvedAction).toUpperCase(),
      description,
      log_data,
      ip_address: req?.ip || req?.headers?.["x-forwarded-for"] || null,
      user_agent: req?.headers?.["user-agent"] || null,
      entity,
      entity_id: storedEntityId,
    });

    try {
      scheduleNotifyFromActivity(req, {
        action: resolvedAction,
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
