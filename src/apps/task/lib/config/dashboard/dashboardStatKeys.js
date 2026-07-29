/** Dashboard stat card keys — same as frontend TaskConstant STAT_CARDS */
export const DASHBOARD_STAT_KEYS = [
  "open_tasks",
  "updated_tasks",
  "total",
  "pending",
  "in_progress",
  "action_required",
  "completed",
  "overdue",
  "new_today",
  "reminder",
  "upcoming_due",
  "creator_pending",
];

export const DASHBOARD_STAT_LABELS = {
  open_tasks: "Open Tasks",
  updated_tasks: "Not Viewed",
  total: "Total Tasks",
  pending: "Pending",
  in_progress: "In Progress",
  action_required: "Action Required",
  completed: "Completed",
  overdue: "Overdue",
  new_today: "New Today",
  reminder: "Reminders",
  upcoming_due: "Upcoming Due",
  creator_pending: "Pending Approval",
};

/** Task.getStats() row → template / ERP vars (string counts) */
export function buildNotifyVarsFromDashboardStats(stats = {}) {
  const out = {};
  for (const key of DASHBOARD_STAT_KEYS) {
    const n = stats[key];
    out[key] = String(n != null && !Number.isNaN(Number(n)) ? Number(n) : 0);
  }
  return out;
}
