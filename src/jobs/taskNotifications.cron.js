import dbQuery from "../config/db.js";
import { MST_TABLES as M, TASK_TABLES as T } from "../config/dbTables.js";
import NotificationTemplate from "../apps/task/models/notificationTemplate.model.js";
import Task from "../apps/task/models/task.model.js";
import { sendTaskNotification } from "../apps/task/services/notification.service.js";
import { buildNotifyVarsFromDashboardStats } from "../apps/task/config/dashboardStatKeys.js";
import { scheduleDeferred } from "./cronUtil.js";

const BATCH = 8;
const DAILY_GRACE_MINUTES = 10;
let lastDailyRunDate = "";

function getIstNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function isWithinDailyWindow(triggerTime) {
  const [hh, mm] = triggerTime.split(":").map(Number);
  const ist = getIstNow();
  const nowMins = ist.getHours() * 60 + ist.getMinutes();
  const triggerMins = hh * 60 + mm;
  return nowMins >= triggerMins && nowMins < triggerMins + DAILY_GRACE_MINUTES;
}

async function inBatches(items, fn, size = BATCH) {
  let failed = 0;
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const results = await Promise.allSettled(chunk.map(fn));
    failed += results.filter((r) => r.status === "rejected").length;
  }
  return failed;
}

async function getUsersForDailyReminder() {
  return dbQuery(
    `SELECT DISTINCT u.id, u.type AS role
     FROM ${M.USERS} u
     INNER JOIN ${T.TASKS} t ON (
       t.first_assigned_to = u.id
       OR t.current_holder_id = u.id
       OR EXISTS (
         SELECT 1 FROM ${T.ASSIGNMENTS} ta
         WHERE ta.task_id = t.task_id AND ta.assigned_to = u.id AND ta.is_active = TRUE
       )
     )
     WHERE u.is_deleted = false AND u.status = 'active' AND t.status != 'closed'`
  );
}

async function runDailyReminders() {
  const tpl = await NotificationTemplate.getByKey("daily_reminder");
  if (!tpl?.is_enabled || !tpl.trigger_time) return;

  const today = new Date().toISOString().slice(0, 10);
  if (lastDailyRunDate === today) return;

  if (!isWithinDailyWindow(tpl.trigger_time)) return;

  lastDailyRunDate = today;
  const users = await getUsersForDailyReminder();
  if (!users.length) return;

  let sent = 0;
  let skipped = 0;
  const failed = await inBatches(users, async (row) => {
    const stats = await Task.getStats({
      userId: row.id,
      userRole: row.role ?? "user",
      view: "assigned_to",
    });
    const statVars = buildNotifyVarsFromDashboardStats(stats);
    if (Number(statVars.total) === 0) {
      skipped += 1;
      return;
    }
    await sendTaskNotification("daily_reminder", row.id, statVars, null, { tpl });
    sent += 1;
  });

  if (sent || failed) {
    console.log(`[Task notify] daily: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  }
}

async function runPersonalReminders() {
  const tpl = await NotificationTemplate.getByKey("personal_reminder");
  if (!tpl?.is_enabled) return;

  const rows = await dbQuery(
    `SELECT tsn.task_id, tsn.user_id, tsn.reminder_at, t.title, t.status
     FROM ${T.SELF_NOTES} tsn
     JOIN ${T.TASKS} t ON t.task_id = tsn.task_id
     WHERE tsn.reminder_at IS NOT NULL
       AND tsn.reminder_at <= NOW()
       AND tsn.reminder_at >= NOW() - INTERVAL '5 minutes'
       AND t.status != 'completed'`
  );
  if (!rows.length) return;

  let sent = 0;
  const failed = await inBatches(rows, async (row) => {
    const reminderAt = row.reminder_at instanceof Date
      ? row.reminder_at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      : String(row.reminder_at);
    await sendTaskNotification(
      "personal_reminder",
      row.user_id,
      {
        task_title: row.title,
        task_id: String(row.task_id),
        reminder_at: reminderAt,
        status: row.status,
      },
      row.task_id,
      { tpl }
    );
    sent += 1;
  });

  if (sent || failed) {
    console.log(`[Task notify] personal: ${sent} sent, ${failed} failed`);
  }
}

async function runTaskNotifications() {
  try {
    await runDailyReminders();
    await runPersonalReminders();
  } catch (err) {
    console.error("Task notifications cron error:", err.message);
  }
}

export function initTaskNotificationsCron() {
  scheduleDeferred("* * * * *", runTaskNotifications, {
    name: "task-notifications",
    onMissed: runDailyReminders,
  });
}
