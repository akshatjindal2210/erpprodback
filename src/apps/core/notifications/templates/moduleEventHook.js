import { auditUserName } from "../../lib/utils/auth/approval.js";
import { resolveMiddlewareEntityId } from "../../../../platform/utils/activity/activityLogPayload.js";

const ACTION_TO_EVENT = { add: "add", edit: "edit", delete: "delete", authorize: "approve" };
const APPROVAL_FRESH_MS = 2 * 60 * 1000;

function firstRecord(data) {
  if (Array.isArray(data)) return data.length ? data[0] : null;
  return data && typeof data === "object" ? data : null;
}

function isApprovedFlag(body = {}) {
  const v = body.approved ?? body.approve ?? body.is_approved;
  if (v === true || v === 1) return true;
  if (typeof v === "string" && ["true", "1", "approved", "approve", "final", "yes"].includes(v.trim().toLowerCase())) return true;
  const status = String(body.status ?? "").toLowerCase();
  return status === "approved" || status === "authorized";
}

/** An edit that re-sends approved=true on an already-approved row must not re-fire APPROVE. */
function isFreshApproval(record) {
  if (!record || record.approved_at == null) return true;
  const at = new Date(record.approved_at).getTime();
  return Number.isFinite(at) && Date.now() - at <= APPROVAL_FRESH_MS;
}

export function resolveModuleEvents(req, actionList, record) {
  const declared = actionList.map((a) => ACTION_TO_EVENT[a]).filter(Boolean);
  if (!declared.length) return [];

  const url = String(req.originalUrl || "").toLowerCase().split("?")[0];
  let primary = null;
  if (/\/(approve|authorize)(\/|$)/.test(url)) primary = "approve";
  else if (req.method === "DELETE" || /\/(delete|remove)(\/|$)/.test(url)) primary = "delete";
  else if (/\/(create|add|insert)(\/|$)/.test(url)) primary = "add";
  else if (req.method === "PUT" || req.method === "PATCH" || /\/(update|edit)(\/|$)/.test(url)) primary = "edit";
  else if (declared.length === 1 && !actionList.includes("view")) primary = declared[0];
  if (!primary) return [];

  const events = [primary];
  if (primary !== "approve" && primary !== "delete" && isApprovedFlag(req.body) && isFreshApproval(record)) {
    events.push("approve");
  }
  return events;
}

/**
 * Called by accessControl once the user is allowed: after a successful JSON response,
 * fire module notification templates for the resolved event(s) in the background.
 */
export function attachModuleEventHook(req, res, moduleName, actions) {
  if (req._moduleEventHooked || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return;
  const actionList = Array.isArray(actions) ? actions : [actions];
  if (!actionList.some((a) => ACTION_TO_EVENT[a])) return;
  req._moduleEventHooked = true;

  const originalJson = res.json.bind(res);
  res.json = function (payload) {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300 && payload && payload.success !== false) {
        const record = firstRecord(payload.data);
        const events = resolveModuleEvents(req, actionList, record);
        if (events.length) {
          const job = {
            moduleName,
            events,
            record,
            body: req.body,
            recordId: resolveMiddlewareEntityId(req, payload.data),
            actorName: auditUserName(req),
          };
          setImmediate(() => {
            import("./moduleNotify.service.js")
              .then(({ dispatchModuleEvent }) => dispatchModuleEvent(job))
              .catch((err) => console.error("[Module notify] hook failed:", err.message));
          });
        }
      }
    } catch (err) {
      console.error("[Module notify] hook error:", err.message);
    }
    return originalJson(payload);
  };
}
