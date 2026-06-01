import dbQuery from "../db.js";

const ACTION_LABELS = { POST: "CREATE", PUT: "UPDATE", PATCH: "MODIFY", DELETE: "DELETE" };
const MODULES = {
  users: "user",
  task_tasks: "task",
  task_categories: "category",
  departments: "department",
  designations: "designation",
  holidays: "task_holiday",
};

function getModuleName(route) {
  const segment = Object.keys(MODULES).find(key => route.includes(key));
  return MODULES[segment] || "record";
}

function buildAction(method, route, resourceId, body) {
  const module = getModuleName(route);
  const identifier = body?.name || body?.title || "";
  const label = identifier ? `: "${identifier}"` : "";
  const idStr = resourceId ? ` #${resourceId}` : "";

  const actions = {
    POST: `Created a new ${module}${label}`,
    PUT: `Updated ${module}${idStr}${label}`,
    PATCH: `Modified ${module}${idStr}${label}`,
    DELETE: route.includes("bulk") ? `Bulk deleted multiple ${module}s` : `Deleted ${module}${idStr}`
  };
  return actions[method] || `Performed ${method} on ${module}`;
}

export function activityLogger(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();

  const originalJson = res.json.bind(res);

  res.json = function (data) {
    if (res.statusCode >= 200 && res.statusCode < 300 && data?.success) {
      const userId = req.user?.id;
      
      if (userId) {
        const userType = req.user?.type ?? "user";
        const resourceId = req.params?.id || data?.data?.id || null;
        const module = getModuleName(req.originalUrl);
        const description = buildAction(req.method, req.originalUrl, resourceId, req.body);
        
        let logDetails = null;

        if (req.method === "DELETE") {
          logDetails = { 
            id: resourceId, 
            type: "removal", 
            bulk: req.originalUrl.includes("bulk"),
            affected_ids: req.body?.ids || null 
          };
        } else {
          const payload = { ...req.body };
          ["password", "confirmPassword", "oldPassword", "token"].forEach(f => delete payload[f]);
          logDetails = Object.keys(payload).length > 0 ? payload : null;
        }

        // 1. Log to Task-specific table
        dbQuery(
          `INSERT INTO task_users_logs (user_id, action_type, module, description, user_type, log_data)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            userId, 
            ACTION_LABELS[req.method] || req.method, 
            module, 
            description, 
            userType, 
            logDetails ? JSON.stringify(logDetails) : null
          ]
        ).catch(err => console.error("[Task ActivityLogger] DB Error:", err.message));
      }
    }
    return originalJson(data);
  };

  next();
}
