import { findLogs } from "../models/activityLog.model.js";

/** Non–super_admin users only see their own activity logs. */
function buildRoleFilters(req) {
  const { id: userId, type: userRole } = req.user;
  const filterUserId = req.body?.filters?.userId;

  if (userRole === "super_admin") {
    return { userId: filterUserId || null };
  }

  return { userId };
}

export const getLogs = async (req, res) => {
  try {
    const { page, limit, sortBy, order, search, filters = {} } = req.body;
    const roleFilters = buildRoleFilters(req);
    const result = await findLogs({
      page,
      limit,
      sortBy,
      order,
      search,
      filters: { ...filters, ...roleFilters },
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
