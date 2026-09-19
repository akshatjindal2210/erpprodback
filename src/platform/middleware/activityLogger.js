import ActivityLog from "../../apps/core/activity-logs/models/activityLog.model.js";
import { buildMiddlewareLogPayload, resolveMiddlewareEntityId } from "../utils/activity/activityLogPayload.js";

const ACTION_LABELS = { POST: "CREATE", PUT: "UPDATE", PATCH: "MODIFY", DELETE: "DELETE" };

const ROUTE_SKIP = new Set([
  "api", "core", "ims", "task", "hrms", "rmstore", "purchase", "production", "portal",
  "list", "get", "fetch", "search", "filter", "details", "report", "export", "download",
  "history", "summary", "meta", "helper", "create", "add", "insert", "save", "update",
  "edit", "modify", "delete", "remove", "approve", "authorize", "generate", "machine",
  "submit", "sync",
]);

const HRMS_MODULES = {
  employees: "hrms_employee",
  attendance: "hrms_attendance",
  "attendance-log": "hrms_attendance_log",
  "gate-pass": "hrms_gate_pass",
};

function resolveMiddlewareModule(originalUrl, appType) {
  const parts = originalUrl
    .split("/")
    .filter((part) => part && !ROUTE_SKIP.has(part.toLowerCase()));

  const first = (parts[0] || "").toLowerCase();
  if (appType === "hrms" && HRMS_MODULES[first]) return HRMS_MODULES[first];

  return (parts[0] || "general").replace(/-/g, "_");
}

export const activityLogger = (appType) => {
  return (req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();

    const url = req.originalUrl.toLowerCase();

    const isExplicitRead = [
      "list", "get", "fetch", "search", "filter", "stats", "me",
      "views", "check", "preview", "details", "report", "export",
      "download", "history", "summary", "meta", "helper",
    ].some((pattern) => url.includes(pattern));

    if (isExplicitRead) return next();

    if (req.method === "POST") {
      const writeKeywords = [
        "create", "add", "insert", "save", "update", "edit", "modify",
        "delete", "remove", "approve", "authorize", "generate",
        "link", "unlink", "sync", "apply", "revert", "reset", "change",
        "cancel", "reject", "submit", "process", "upload", "import",
      ];
      const isWriteAction = writeKeywords.some((pattern) => url.includes(pattern));
      const isListBody =
        req.body &&
        (req.body.page !== undefined ||
          req.body.limit !== undefined ||
          req.body.filters !== undefined ||
          req.body.search !== undefined);

      if (!isWriteAction || (isListBody && !isWriteAction)) return next();
    }

    if (req._activityLogged) return next();

    const originalJson = res.json.bind(res);

    res.json = function (data) {
      if (res.statusCode >= 200 && res.statusCode < 300 && data?.success && !req._activityLogged) {
        const userId = req.user?.id;
        if (userId) {
          const routeUrl = req.originalUrl.toLowerCase();
          const module = resolveMiddlewareModule(req.originalUrl, appType);

          let actionType = ACTION_LABELS[req.method] || req.method;

          if (req.method === "POST") {
            const isApproval =
              req.body.approved === true ||
              req.body.approve === true ||
              req.body.is_approved === true ||
              req.body.status === "approved" ||
              req.body.status === "authorized" ||
              routeUrl.includes("/approve") ||
              routeUrl.includes("/authorize");

            if (isApproval) actionType = "APPROVE";
            else if (
              routeUrl.includes("/update") ||
              routeUrl.includes("/edit") ||
              routeUrl.includes("/modify") ||
              routeUrl.includes("/sync") ||
              routeUrl.includes("/deactivate")
            ) {
              actionType = "UPDATE";
            } else if (routeUrl.includes("/delete") || routeUrl.includes("/remove")) {
              actionType = "DELETE";
            }
          }

          const entityId = resolveMiddlewareEntityId(req, data?.data);
          const { description, log_data, entity_id, entity_ref } = buildMiddlewareLogPayload({
            actionType,
            module,
            entityId,
            body: req.body,
            responseData: data?.data,
            route: routeUrl,
          });

          req._activityLogged = true;

          const storedEntityId =
            entity_ref != null && String(entity_ref).trim() !== ""
              ? String(entity_ref).trim()
              : entity_id != null
                ? String(entity_id)
                : null;

          ActivityLog.create({
            user_id: userId,
            app_type: appType,
            module,
            action_type: actionType,
            description,
            log_data,
            ip_address: req.ip,
            user_agent: req.get("User-Agent"),
            entity: module,
            entity_id: storedEntityId,
          }).catch((err) => console.error("[ActivityLogger] Error:", err.message));
        }
      }
      return originalJson(data);
    };

    next();
  };
};
