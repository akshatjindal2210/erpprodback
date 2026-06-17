import dbQuery from "../config/db.js";
import ClTask from "../apps/task/models/clTask.model.js";
import { parseFormSchema } from "../apps/task/helpers/clTaskForm.helper.js";
import { parseRecurrenceArray, computeClNextOccurrence } from "../apps/task/helpers/clTaskRecurrence.helper.js";
import { scheduleDeferred } from "./cronUtil.js";

async function processClFrequentTasks() {
  const today = new Date().toISOString().split("T")[0];
  const frequentTasks = await ClTask.getFrequentTasksDue(today);

  for (const ct of frequentTasks) {
    if (ct.end_date_time && today > new Date(ct.end_date_time).toISOString().split("T")[0]) {
      await dbQuery(
        `UPDATE task_cl_tasks SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE cl_task_id = ?`,
        [ct.cl_task_id],
      );
      continue;
    }

    const recurrenceData = {
      recurrence_weekdays: parseRecurrenceArray(ct.recurrence_weekdays),
      recurrence_month_dates: parseRecurrenceArray(ct.recurrence_month_dates),
      recurrence_year_dates: parseRecurrenceArray(ct.recurrence_year_dates),
    };

    await ClTask.createInstance({
      cl_task_id: ct.cl_task_id,
      title: ct.title,
      description: ct.description,
      sop_description: ct.sop_description,
      task_type: ct.task_type,
      recurrence_type: ct.recurrence_type,
      ...recurrenceData,
      wastage: ct.wastage,
      verification_user_id: ct.verification_user_id,
      department_id: ct.department_id,
      designation_id: ct.designation_id,
      person_id: ct.person_id,
      end_date_time: ct.end_date_time,
      scheduled_date: ct.next_occurrence,
      status: "pending",
      form_schema: parseFormSchema(ct.form_schema),
      verification_required: ct.verification_required,
      scoring_enabled: ct.scoring_enabled,
    });

    const nextDate = computeClNextOccurrence(ct.recurrence_type, recurrenceData);
    await ClTask.updateNextOccurrence(ct.cl_task_id, nextDate);
  }

  if (frequentTasks.length > 0) {
    console.log(`✅ CL frequent tasks processed (${frequentTasks.length}) at`, new Date());
  }
}

export function initClTasksCron() {
  scheduleDeferred("0 0 * * *", async () => {
    try {
      await processClFrequentTasks();
    } catch (err) {
      console.error("❌ CL tasks cron error:", err);
    }
  }, { name: "cl-tasks" });
}

export { processClFrequentTasks };
