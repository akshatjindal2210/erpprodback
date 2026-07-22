import ClTask from "../models/clTask.model.js";
import { parseFormSchema, parseClAttachments } from "./clTaskForm.helper.js";
import { parseRecurrenceArray } from "./clTaskRecurrence.helper.js";
import { getISTDateString, toYmd, isClTaskMissed } from "./clTaskTime.helper.js";
import { resolveClMasterAssignees } from "./clTaskAssignee.helper.js";

export function masterSnapshotForInstance(master, scheduledDate, personOverride = null) {
  const recurrenceData = {
    recurrence_weekdays: parseRecurrenceArray(master.recurrence_weekdays),
    recurrence_month_dates: parseRecurrenceArray(master.recurrence_month_dates),
    recurrence_year_dates: parseRecurrenceArray(master.recurrence_year_dates),
  };
  const attachments = parseClAttachments(master.attachment);
  const personId = personOverride?.id ?? master.person_id ?? null;
  return {
    cl_task_id: master.cl_task_id,
    title: master.title,
    description: master.description,
    sop_description: master.sop_description,
    task_type: master.task_type,
    recurrence_type: master.recurrence_type,
    ...recurrenceData,
    weightage: Number(master.weightage ?? master.wastage) || 1,
    verification_user_id: master.verification_user_id || null,
    department_id: personOverride?.department_id ?? master.department_id ?? null,
    designation_id: personOverride?.designation_id ?? master.designation_id ?? null,
    person_id: personId || null,
    due_time: master.task_type === "frequently" ? (master.due_time || "11:00") : null,
    day_offset: master.task_type === "frequently"
      ? (Number.isFinite(Number(master.day_offset))
        ? Math.max(0, Math.min(14, Math.floor(Number(master.day_offset))))
        : 0)
      : 0,
    scheduled_date: toYmd(scheduledDate) || getISTDateString(),
    status: "pending",
    form_schema: parseFormSchema(master.form_schema),
    verification_required: master.verification_required !== false,
    scoring_enabled: master.scoring_enabled !== false,
    sop_required: master.sop_required === true,
    attachment: attachments.length ? attachments : null,
  };
}

/** Spawn one pending instance per assignee for a scheduled day (idempotent). */
export async function spawnInstancesForMasterDay(master, cursor, { onlyPersonId = null } = {}) {
  let people = await resolveClMasterAssignees(master);
  if (master.verification_user_id) {
    const vid = Number(master.verification_user_id);
    people = people.filter((p) => Number(p.id) !== vid);
  }
  if (onlyPersonId != null && onlyPersonId !== "") {
    const pid = Number(onlyPersonId);
    people = people.filter((p) => Number(p.id) === pid);
  }

  let created = 0;
  for (const person of people) {
    const already = await ClTask.hasPendingInstanceForDay(master.cl_task_id, person.id, cursor);
    if (already) continue;
    const shell = {
      task_type: "frequently",
      status: "pending",
      scheduled_date: cursor,
      due_time: master.due_time || "11:00",
      day_offset: master.day_offset,
    };
    if (isClTaskMissed(shell)) continue;
    await ClTask.createInstance(masterSnapshotForInstance(master, cursor, person));
    created += 1;
  }
  return created;
}
