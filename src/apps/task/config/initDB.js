import { createTaskCategoriesTable } from "./tables/category.table.js";
import { createTaskHolidayTable } from "./tables/holiday.table.js";
import { createTaskTasksTable } from "./tables/tasks.table.js";
import { createTaskRecurringTasksTable, createTaskRecurringTaskAssignmentsTable, createTaskRecurringTaskChatTable } from "./tables/recurring_tasks.table.js";
import { createTaskAssignmentsTable } from "./tables/task_assignments.table.js";
import { createTaskChatTable } from "./tables/task_chat.table.js";
import { createTaskSelfNotesTable } from "./tables/task_self_notes.table.js";
import { createTaskLogTable } from "./tables/task_log.table.js";
import { createTaskUpdatedAtTriggers } from "./tables/triggers.table.js";
import { createTaskUsersLogsTable } from "./tables/users_logs.table.js";
import { syncTaskSequences } from "./syncSequences.js";

export async function initTaskDB() {
  try {
    await createTaskCategoriesTable();
    await createTaskHolidayTable();

    await createTaskTasksTable();
    await createTaskUsersLogsTable();

    await createTaskRecurringTasksTable();
    await createTaskRecurringTaskAssignmentsTable();
    await createTaskRecurringTaskChatTable();

    await createTaskAssignmentsTable();
    await createTaskChatTable();
    await createTaskSelfNotesTable();
    await createTaskLogTable();

    await createTaskUpdatedAtTriggers();

    // Sync sequences to prevent duplicate key errors
    await syncTaskSequences();

    console.log("✅ Task tables ready");
  } catch (err) {
    console.error("❌ Task DB initialization failed:", err.message);
    throw err;
  }
}
