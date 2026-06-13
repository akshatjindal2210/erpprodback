import TaskAppConfig, { TASK_CONFIG_KEYS } from "../models/taskAppConfig.model.js";

const DEFAULT_TEMPLATES = {
  task_assigned: {
    template_key: "task_assigned",
    label: "New Task Assigned",
    subject: "New task: {{task_title}}",
    body: "Hi {{user_name}},\n\nA new task has been assigned to you.\n\nTask: {{task_title}} (#{{task_id}})\nAssigned by: {{assigned_by}}\nDue: {{due_date}}\n\nPlease check the Task app for details.",
    is_enabled: false,
    pwa_enabled: false,
    api_enabled: false,
    send_via: "none",
    trigger_time: null,
  },
  daily_reminder: {
    template_key: "daily_reminder",
    label: "Daily Auto Reminder",
    subject: "Your task dashboard - {{action_required}} action required",
    body: "Hi {{user_name}},\n\nYour task summary (Assigned To Me):\n\nOpen: {{open_tasks}} | Updated: {{updated_tasks}} | Total: {{total}}\nPending: {{pending}} | In Progress: {{in_progress}} | Action Required: {{action_required}}\nCompleted: {{completed}} | Overdue: {{overdue}} | New Today: {{new_today}}\nReminders: {{reminder}} | Upcoming Due: {{upcoming_due}} | Pending Approval: {{creator_pending}}\n\nPlease check the Task app today.",
    is_enabled: false,
    pwa_enabled: false,
    api_enabled: false,
    send_via: "none",
    trigger_time: "09:00",
  },
  personal_reminder: {
    template_key: "personal_reminder",
    label: "Personal Reminder",
    subject: "Personal reminder: {{task_title}}",
    body: "Hi {{user_name}},\n\nYour personal reminder for task: {{task_title}} (#{{task_id}})\nReminder at: {{reminder_at}}\n\nPlease check the Task app.",
    is_enabled: false,
    pwa_enabled: false,
    api_enabled: false,
    send_via: "none",
    trigger_time: null,
  },
  target_date_set: {
    template_key: "target_date_set",
    label: "Target Date Set",
    subject: "Target date for {{task_title}}",
    body: "Hi {{user_name}},\n\n{{assigned_to_name}} (Assigned To) has set the target date.\n\nTask: {{task_title}} (#{{task_id}})\nTarget date: {{target_date}}\n\nTask is now in progress.",
    is_enabled: false,
    pwa_enabled: false,
    api_enabled: false,
    send_via: "none",
    trigger_time: null,
  },
  status_changed: {
    template_key: "status_changed",
    label: "Status Changed",
    subject: "Task status updated: {{task_title}}",
    body: "Hi {{user_name}},\n\nTask status has been updated.\n\nTask: {{task_title}} (#{{task_id}})\nNew status: {{status}}\n\nPlease check the Task app for details.",
    is_enabled: false,
    pwa_enabled: false,
    api_enabled: false,
    send_via: "none",
    trigger_time: null,
  },
};

function withChannelDefaults(tpl) {
  if (!tpl) return tpl;
  const sendVia = tpl.send_via || "none";
  return {
    ...tpl,
    pwa_enabled: tpl.pwa_enabled !== undefined ? !!tpl.pwa_enabled : !!tpl.is_enabled,
    api_enabled:
      tpl.api_enabled !== undefined
        ? !!tpl.api_enabled
        : !!tpl.is_enabled && sendVia !== "none",
  };
}

export async function seedTaskNotificationTemplates() {
  const existing = await TaskAppConfig.getJson(TASK_CONFIG_KEYS.NOTIFICATION_TEMPLATES, null);
  if (!existing || Object.keys(existing).length === 0) {
    await TaskAppConfig.set(TASK_CONFIG_KEYS.NOTIFICATION_TEMPLATES, DEFAULT_TEMPLATES);
    return;
  }

  let changed = false;

  const daily = existing.daily_reminder;
  if (daily?.body?.includes("{{task_title}}")) {
    existing.daily_reminder = {
      ...daily,
      subject: DEFAULT_TEMPLATES.daily_reminder.subject,
      body: DEFAULT_TEMPLATES.daily_reminder.body,
    };
    changed = true;
  }

  for (const key of Object.keys(existing)) {
    const tpl = existing[key];
    if (!tpl || tpl.pwa_enabled !== undefined) continue;
    existing[key] = withChannelDefaults(tpl);
    changed = true;
  }

  if (changed) {
    await TaskAppConfig.set(TASK_CONFIG_KEYS.NOTIFICATION_TEMPLATES, existing);
  }
}
