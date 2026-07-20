import config from "../config/config.js";
import ClTask from "../apps/task/models/clTask.model.js";
import { parseFormSchema, parseClAttachments } from "../apps/task/helpers/clTaskForm.helper.js";
import { parseRecurrenceArray, computeClNextOccurrence, isClOccurrenceDay } from "../apps/task/helpers/clTaskRecurrence.helper.js";
import { getISTDateString, getISTHour, toYmd, isClTaskMissed } from "../apps/task/helpers/clTaskTime.helper.js";
import { deferCronWork, scheduleDeferred } from "./cronUtil.js";

/** Shared lock — main cron + hourly catch-up + startup/missed must not overlap. */
let cloneBusy = false;

function getCloneHour() {
  const hour = config.clTask?.cloneAllowedHour;
  return hour == null || !Number.isFinite(Number(hour)) ? null : Number(hour);
}

/** Cron expression from CL_CLONE_ALLOWED_HOUR (IST). Blank → midnight. */
export function getClCloneCronExpression() {
  const hour = getCloneHour();
  return `0 ${hour == null ? 0 : hour} * * *`;
}

/** True when CL_CLONE_ALLOWED_HOUR gate allows spawning (IST). */
export function canRunClCloneNow() {
  const hour = getCloneHour();
  if (hour != null && getISTHour() < hour) return false;
  return true;
}

function mergeMastersById(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      if (row?.cl_task_id != null) map.set(Number(row.cl_task_id), row);
    }
  }
  return [...map.values()];
}

/**
 * Create missing frequent instances for Due.
 * Idempotent via hasPendingInstanceForDay — safe from cron + Due API.
 */
export async function processClFrequentTasks({ personId = null } = {}) {
  const today = getISTDateString();
  const due = await ClTask.getFrequentTasksDue(today);
  const recovery = await ClTask.getFrequentTasksForTodayRecovery(today);
  let frequentTasks = mergeMastersById(due, recovery);

  if (personId != null && personId !== "") {
    const pid = Number(personId);
    frequentTasks = frequentTasks.filter((ct) => Number(ct.person_id) === pid);
  }

  let created = 0;
  for (const ct of frequentTasks) {
    const recurrenceData = {
      recurrence_weekdays: parseRecurrenceArray(ct.recurrence_weekdays),
      recurrence_month_dates: parseRecurrenceArray(ct.recurrence_month_dates),
      recurrence_year_dates: parseRecurrenceArray(ct.recurrence_year_dates),
    };

    let cursor = toYmd(ct.next_occurrence) || today;

    // Recovery: next already jumped to tomorrow+ but today still needs a clone
    // (classic bug: due_time 00:00 / 12:00 AM made today look "missed").
    if (cursor > today) {
      const hasToday = await ClTask.hasPendingInstanceForDay(ct.cl_task_id, ct.person_id, today);
      if (
        !hasToday &&
        isClOccurrenceDay(ct.recurrence_type, recurrenceData, today)
      ) {
        cursor = today;
      } else {
        continue;
      }
    }

    let guard = 0;
    while (cursor && cursor <= today && guard < 60) {
      guard += 1;
      const already = await ClTask.hasPendingInstanceForDay(ct.cl_task_id, ct.person_id, cursor);
      if (!already) {
        const shell = {
          task_type: "frequently",
          status: "pending",
          scheduled_date: cursor,
          due_time: ct.due_time || "11:00",
          day_offset: ct.day_offset,
        };
        if (!isClTaskMissed(shell)) {
          const attachments = parseClAttachments(ct.attachment);
          await ClTask.createInstance({
            cl_task_id: ct.cl_task_id,
            title: ct.title,
            description: ct.description,
            sop_description: ct.sop_description,
            task_type: ct.task_type,
            recurrence_type: ct.recurrence_type,
            ...recurrenceData,
            weightage: Number(ct.weightage) || 1,
            verification_user_id: ct.verification_user_id,
            department_id: ct.department_id,
            designation_id: ct.designation_id,
            person_id: ct.person_id,
            due_time: ct.due_time || "11:00",
            day_offset: ct.day_offset,
            scheduled_date: cursor,
            status: "pending",
            form_schema: parseFormSchema(ct.form_schema),
            verification_required: ct.verification_required,
            scoring_enabled: ct.scoring_enabled,
            sop_required: ct.sop_required === true,
            attachment: attachments.length ? attachments : null,
          });
          created += 1;
        }
      }
      cursor = computeClNextOccurrence(ct.recurrence_type, recurrenceData, cursor);
    }

    await ClTask.updateNextOccurrence(ct.cl_task_id, cursor);
  }

  if (frequentTasks.length > 0) {
    console.log(`✅ CL frequent tasks processed (${frequentTasks.length} master(s), ${created} new)`);
  }

  return frequentTasks.length;
}

/**
 * Spawn due frequent instances when CL_CLONE_ALLOWED_HOUR allows.
 * Idempotent — may run many times per day (catch-up for new masters / failed spawns).
 */
export async function runClClone({ reason, personId = null } = {}) {
  if (cloneBusy) return 0;
  // Due list must show today's frequent clones when the user opens the page.
  // Cron / hourly still respect CL_CLONE_ALLOWED_HOUR.
  const bypassHourGate = reason === "due-list";
  if (!bypassHourGate && !canRunClCloneNow()) return 0;

  cloneBusy = true;
  try {
    return await processClFrequentTasks({ personId });
  } catch (err) {
    console.error("❌ CL tasks cron error:", err);
    return 0;
  } finally {
    cloneBusy = false;
  }
}

/**
 * Frequent CL masters → instances at CL_CLONE_ALLOWED_HOUR (IST).
 * Blank env → midnight. Catch-up: startup, missed tick, hourly safety net.
 */
export function initClTasksCron() {
  const expression = getClCloneCronExpression();
  const hour = getCloneHour();

  scheduleDeferred(expression, runClClone, {
    name: "cl-tasks",
    onMissed: () => runClClone({ reason: "missed" }),
  });

  scheduleDeferred("5 * * * *", () => runClClone({ reason: "hourly-catchup" }), {
    name: "cl-tasks-catchup",
  });

  console.log(
    `[cl-tasks] scheduled "${expression}" Asia/Kolkata` +
      (hour == null ? " (CL_CLONE_ALLOWED_HOUR blank → midnight)" : ` (CL_CLONE_ALLOWED_HOUR=${hour})`),
  );

  deferCronWork(() => runClClone({ reason: "startup" }));
}
