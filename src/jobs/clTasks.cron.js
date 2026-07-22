import config from "../config/config.js";
import ClTask from "../apps/task/models/clTask.model.js";
import { parseRecurrenceArray, computeClNextOccurrence, isClOccurrenceDay } from "../apps/task/helpers/clTaskRecurrence.helper.js";
import { getISTDateString, getISTHour, toYmd } from "../apps/task/helpers/clTaskTime.helper.js";
import { resolveClMasterAssignees } from "../apps/task/helpers/clTaskAssignee.helper.js";
import { spawnInstancesForMasterDay } from "../apps/task/helpers/clTaskSpawn.helper.js";
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
 * One master → N person instances (dept / designation / person scope).
 * Idempotent via hasPendingInstanceForDay.
 */
export async function processClFrequentTasks({ personId = null } = {}) {
  const today = getISTDateString();
  const due = await ClTask.getFrequentTasksDue(today);
  const recovery = await ClTask.getFrequentTasksForTodayRecovery(today);
  let frequentTasks = mergeMastersById(due, recovery);

  if (personId != null && personId !== "") {
    const pid = Number(personId);
    const scoped = [];
    for (const ct of frequentTasks) {
      const people = await resolveClMasterAssignees(ct);
      if (people.some((p) => Number(p.id) === pid)) scoped.push(ct);
    }
    frequentTasks = scoped;
  }

  let created = 0;
  for (const ct of frequentTasks) {
    const recurrenceData = {
      recurrence_weekdays: parseRecurrenceArray(ct.recurrence_weekdays),
      recurrence_month_dates: parseRecurrenceArray(ct.recurrence_month_dates),
      recurrence_year_dates: parseRecurrenceArray(ct.recurrence_year_dates),
    };

    let cursor = toYmd(ct.next_occurrence) || today;

    if (cursor > today) {
      const people = await resolveClMasterAssignees(ct);
      const targets =
        personId != null && personId !== ""
          ? people.filter((p) => Number(p.id) === Number(personId))
          : people;
      let needsToday = false;
      if (isClOccurrenceDay(ct.recurrence_type, recurrenceData, today)) {
        for (const person of targets) {
          const hasToday = await ClTask.hasPendingInstanceForDay(ct.cl_task_id, person.id, today);
          if (!hasToday) {
            needsToday = true;
            break;
          }
        }
      }
      if (needsToday) {
        cursor = today;
      } else {
        continue;
      }
    }

    let guard = 0;
    while (cursor && cursor <= today && guard < 60) {
      guard += 1;
      created += await spawnInstancesForMasterDay(ct, cursor, { onlyPersonId: personId });
      cursor = computeClNextOccurrence(ct.recurrence_type, recurrenceData, cursor);
    }

    // Never advance master cursor on a single-person catch-up — other assignees would miss days.
    if (personId == null || personId === "") {
      await ClTask.updateNextOccurrence(ct.cl_task_id, cursor);
    }
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
 */
export function initClTasksCron() {
  const expression = getClCloneCronExpression();

  scheduleDeferred(expression, runClClone, {
    name: "cl-tasks",
    onMissed: () => runClClone({ reason: "missed" }),
  });

  scheduleDeferred("5 * * * *", () => runClClone({ reason: "hourly-catchup" }), {
    name: "cl-tasks-catchup",
  });

  deferCronWork(() => runClClone({ reason: "startup" }));
}
