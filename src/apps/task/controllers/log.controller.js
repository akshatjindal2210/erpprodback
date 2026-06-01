import UserActivityLog from "../models/log.model.js";

// super_admin — all logs; optional filter by user_id or user_type (query params)
function buildRoleFilters(req) {
  const { id: userId, type: userRole } = req.user;
  const { filterUserId, filterUserType } = req.query;

  if (userRole === "super_admin") {
    // All users — optional filters
    return {
      targetUserId:   filterUserId   || null,  // specific user logs
      targetUserType: filterUserType || null,  // "admin" | "user" | "super_admin"
    };
  }

  if (userRole === "admin") {
    return {
      targetUserId:   userId,
      targetUserType: filterUserType || null,
    };
  }

  return {
    targetUserId:   userId,
    targetUserType: null,
  };
}

function formatLog(l) {
  let logData = l.log_data ?? null;
  if (logData && typeof logData === "string") {
    try {
      logData = JSON.parse(logData);
    } catch {
      logData = null;
    }
  }
  return {
    id:          l.id,
    action_type: l.action || l.action_type,
    module:      l.module,
    description: l.description,
    user_type:   l.user_type,
    log_data:    logData,
    created_at:  l.created_at,
    user_id:     l.user_id,
    user: {
      name:     l.user_name,
      username: l.user_username,
    },
  };
}

// GET /logs
export async function getUserLogs(req, res) {
  try {
    const {
      search = "", page = 1, limit = 10,
      sortBy = "created_at", order = "DESC",
      dateFrom, dateTo,
    } = req.query;

    const { targetUserId, targetUserType } = buildRoleFilters(req);

    const filters = {
      search, page, limit, sortBy, order, dateFrom, dateTo,
      targetUserId, targetUserType,
    };

    const [logs, total] = await Promise.all([
      UserActivityLog.getAll(filters),
      UserActivityLog.count({ search, dateFrom, dateTo, targetUserId, targetUserType }),
    ]);

    res.json({
      success: true,
      message: "User logs fetched successfully",
      data: {
        page:       Number(page),
        limit:      Number(limit),
        total,
        totalPages: Math.ceil(total / limit),
        data:       logs.map(formatLog),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /logs/:id
export async function getUserLogById(req, res) {
  try {
    const { id }    = req.params;
    const { id: userId, type: userRole } = req.user;

    const l = await UserActivityLog.getById(id);
    if (!l)
      return res.status(404).json({ success: false, message: "Log not found" });

    if (userRole !== "super_admin" && Number(l.user_id) !== Number(userId))
      return res.status(403).json({ success: false, message: "Access denied" });

    res.json({ success: true, message: "User log fetched successfully", data: formatLog(l) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// DELETE /logs/:id — superOnly (route level)
export async function deleteUserLog(req, res) {
  try {
    const { id }   = req.params;
    const result   = await UserActivityLog.delete(id);

    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: "Log not found" });

    res.json({ success: true, message: "User log deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// DELETE /logs/bulk — superOnly (route level)
export async function bulkDeleteUserLogs(req, res) {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ success: false, message: "ids array is required" });

    const result = await UserActivityLog.bulkDelete(ids);

    res.json({
      success: true,
      message: `${result.affectedRows} log(s) deleted successfully`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}