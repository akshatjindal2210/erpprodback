import ActivityLog from "../../../core/models/activityLog.model.js";
import { buildMiddlewareLogPayload } from "../../../core/utils/activityLogPayload.js";

const ACTION_LABELS = { POST: "CREATE", PUT: "UPDATE", PATCH: "MODIFY", DELETE: "DELETE" };

export function activityLogger(req, res, next) {
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
          else if (routeUrl.includes("/update") || routeUrl.includes("/edit") || routeUrl.includes("/modify")) {
            actionType = "UPDATE";
          } else if (routeUrl.includes("/delete") || routeUrl.includes("/remove")) {
            actionType = "DELETE";
          }
        }

        const parts = req.originalUrl.split("/").filter(Boolean);
        const module = (parts[parts.length - 1] || "record").replace(/-/g, " ");
        const resourceId = req.params?.id || data?.data?.id || req.body?.id || null;

        const { description, log_data, entity_id } = buildMiddlewareLogPayload({
          actionType,
          module,
          entityId: resourceId,
          body: req.body,
          responseData: data?.data,
          route: routeUrl,
        });

        req._activityLogged = true;

        ActivityLog.create({
          user_id: userId,
          app_type: "task",
          module,
          action_type: actionType,
          description,
          log_data,
          ip_address: req.ip,
          user_agent: req.get("User-Agent"),
          entity: module,
          entity_id,
        }).catch((err) => console.error("[Task ActivityLogger] Error:", err.message));
      }
    }
    return originalJson(data);
  };

  next();
}
