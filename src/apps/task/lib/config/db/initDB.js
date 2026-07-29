import { createTaskCategoriesTable } from "../tables/category/category.table.js";
import { createTaskHolidayTable } from "../tables/holidays/holiday.table.js";
import { createTaskTasksTable } from "../tables/tasks/tasks.table.js";
import { createTaskRecurringTasksTable, createTaskRecurringTaskAssignmentsTable, createTaskRecurringTaskChatTable } from "../tables/recurring-task/recurring_tasks.table.js";
import { createTaskAssignmentsTable } from "../tables/tasks/task_assignments.table.js";
import { createTaskChatTable } from "../tables/tasks/task_chat.table.js";
import { createTaskSelfNotesTable } from "../tables/tasks/task_self_notes.table.js";
import { createTaskClTasksMasterTable, createTaskClTasksTable } from "../tables/cl-task/cl_tasks.table.js";
import { createTaskRedTicketsTable } from "../tables/red-ticket/red_tickets.table.js";
import { createTaskMisScoreLedgerTable, createTaskReportReviewsTable } from "../tables/reports/mis_score.table.js";
import { createTaskAppConfigTable } from "../tables/app-config/app_config.table.js";
import { createTaskUpdatedAtTriggers } from "../tables/db/triggers.table.js";
import { syncTaskSequences } from "./syncSequences.js";
import { seedTaskNotificationTemplates } from "./seedNotifications.js";

export async function initTaskDB() {
  try {
    await createTaskCategoriesTable();
    await createTaskHolidayTable();

    await createTaskTasksTable();

    await createTaskRecurringTasksTable();
    await createTaskRecurringTaskAssignmentsTable();
    await createTaskRecurringTaskChatTable();

    await createTaskAssignmentsTable();
    await createTaskChatTable();
    await createTaskSelfNotesTable();
    await createTaskAppConfigTable();

    await createTaskClTasksMasterTable();
    await createTaskClTasksTable();
    await createTaskRedTicketsTable();
    await createTaskMisScoreLedgerTable();
    await createTaskReportReviewsTable();

    await seedTaskNotificationTemplates();

    await createTaskUpdatedAtTriggers();

    await syncTaskSequences();
  } catch (err) {
    console.error("❌ Task DB initialization failed:", err.message);
    throw err;
  }
}
