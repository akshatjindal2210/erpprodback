import ActivityLog from "../models/activityLog.model.js";

export const getActivityLogs = async (req, res) => {
  try {
    const { app_type, module, action_type, page = 1, limit = 20, search, date_from, date_to, entity, entity_id } = req.query;

    const userType = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
    const isSuperAdmin = userType === "super_admin";
    // Super admin → sab users ke logs; baaki → sirf apne
    const user_id = isSuperAdmin ? null : req.user.id;

    const logs = await ActivityLog.getAll({
      user_id,
      app_type,
      module,
      action_type,
      search,
      date_from,
      date_to,
      entity,
      entity_id,
      page: parseInt(page),
      limit: parseInt(limit)
    });

    const total = await ActivityLog.count({
      user_id,
      app_type,
      module,
      action_type,
      search,
      date_from,
      date_to,
      entity,
      entity_id
    });

    res.json({
      success: true,
      data: logs,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
