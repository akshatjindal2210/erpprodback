import ActivityLog from "../models/activityLog.model.js";

export const getActivityLogs = async (req, res) => {
  try {
    const { 
      app_type, module, action_type, 
      page = 1, limit = 100, 
      search, date_from, date_to, 
      entity, entity_id, 
      skipCount,
      isExport, // New flag for export
      user_id: userIdFilter // Super-admin only: filter by a specific user
    } = req.query;

    const userType = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
    const isSuperAdmin = userType === "super_admin";

    // Secure resolution of user_id filter:
    //  - Non super-admin  → always self (ignore any user_id in the query).
    //  - Super-admin      → optional filter by a specific user_id, else null (all users).
    let user_id;
    if (!isSuperAdmin) {
      user_id = req.user.id;
    } else {
      const parsed = parseInt(userIdFilter, 10);
      user_id = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    const isSkipCount = skipCount === "true" || skipCount === true || isExport === "true";
    const fetchOptions = {
      user_id,
      app_type,
      module,
      action_type,
      search,
      date_from,
      date_to,
      entity,
      entity_id,
      page: isExport === "true" ? 1 : parseInt(page),
      limit: isExport === "true" ? 100000 : parseInt(limit), // Max 100k for export
      skipCount: isSkipCount
    };

    const { data: logs, total } = await ActivityLog.getAll(fetchOptions);

    res.json({
      success: true,
      data: logs,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: isSkipCount ? 1 : Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
