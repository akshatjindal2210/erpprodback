import ActivityLog from "../models/activityLog.model.js";

export const getActivityLogs = async (req, res) => {
  try {
    const { app_type, module, action_type, page = 1, limit = 20, all_users, search, date_from, date_to, entity, entity_id } = req.query;
    
    // If not super admin, only show own logs unless specified otherwise
    const user_id = (req.user.role === 'super_admin' && all_users === 'true') ? null : req.user.id;

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
