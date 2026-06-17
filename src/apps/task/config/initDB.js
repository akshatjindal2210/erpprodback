import { createTaskCategoriesTable } from "./tables/category.table.js";
import { createTaskHolidayTable } from "./tables/holiday.table.js";
import { createTaskTasksTable } from "./tables/tasks.table.js";
import { createTaskRecurringTasksTable, createTaskRecurringTaskAssignmentsTable, createTaskRecurringTaskChatTable } from "./tables/recurring_tasks.table.js";
import { createTaskAssignmentsTable } from "./tables/task_assignments.table.js";
import { createTaskChatTable } from "./tables/task_chat.table.js";
import { createTaskSelfNotesTable } from "./tables/task_self_notes.table.js";
// import { createTaskClTasksTable, createTaskClTaskInstancesTable } from "./tables/cl_tasks.table.js";
// import { createTaskRedTicketsTable } from "./tables/red_tickets.table.js";
// import { createTaskMisScoreLedgerTable, createTaskReportReviewsTable } from "./tables/mis_score.table.js";
import { createTaskAppConfigTable } from "./tables/app_config.table.js";
import { createTaskUpdatedAtTriggers } from "./tables/triggers.table.js";
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

    // await createTaskClTasksTable();
    // await createTaskClTaskInstancesTable();
    // await createTaskRedTicketsTable();
    // await createTaskMisScoreLedgerTable();
    // await createTaskReportReviewsTable();

    await seedTaskNotificationTemplates();

    await createTaskUpdatedAtTriggers();

    await syncTaskSequences();

    console.log("✅ Task tables ready");
  } catch (err) {
    console.error("❌ Task DB initialization failed:", err.message);
    throw err;
  }
}
