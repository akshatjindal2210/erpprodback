// reminder.controller.js
import dbQuery from "../shared/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

// GET /api/reminders
// super_admin / admin — all upcoming reminders
export async function getReminders(req, res) {
  try {
    const { id: userId, type: userRole } = req.user;

    const isStaff = userRole === "super_admin" || userRole === "admin";

    const roleFilter = isStaff ? "" : `AND (t.first_assigned_to = ${userId} OR t.current_holder_id = ${userId} OR t.created_by = ${userId})`;

    const reminders = await dbQuery(`
      SELECT
        t.task_id        AS id,
        t.title,
        t.status,
        t.priority,
        t.reminder_date,
        t.due_date,
        STRING_AGG(DISTINCT u.name, ', ') AS assigned_to
      FROM task_tasks t
      LEFT JOIN task_assignments ta ON ta.task_id = t.task_id AND ta.is_active = TRUE
      LEFT JOIN ${M.USERS} u             ON u.id = ta.assigned_to
      WHERE t.reminder_date IS NOT NULL
        AND t.reminder_date >= NOW()
        AND t.reminder_date <= NOW() + INTERVAL '7 days'
        AND t.status NOT IN ('completed')
        ${roleFilter}
      GROUP BY t.task_id, t.title, t.status, t.priority, t.reminder_date, t.due_date
      ORDER BY t.reminder_date ASC
      LIMIT 20
    `);

    res.json({
      success: true,
      message: "Reminders fetched successfully",
      data: reminders,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}