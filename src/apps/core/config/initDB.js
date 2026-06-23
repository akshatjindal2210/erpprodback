import { createUsersTable } from "./tables/user.table.js";
import { createModulesTable } from "./tables/module.table.js";
import { createUserPermissionsTable } from "./tables/user_permissions.table.js";
import { createUserAppAccessTable } from "./tables/user_app_access.table.js";
import { createTrainingVideosTable } from "./tables/training_videos.table.js";
import { createModuleSopsTable } from "./tables/module_sops.table.js";
import { createDepartmentsTable } from "./tables/department.table.js";
import { createDesignationsTable } from "./tables/designation.table.js";
import { createActivityLogsTable } from "./tables/activity_log.table.js";
import { createInboxTable } from "./tables/inbox.table.js";
// import { createUserAppPreferencesTable } from "./tables/user_app_preferences.table.js";
import { createCoreUpdatedAtTriggers } from "./tables/triggers.table.js";

export const initCoreDB = async () => {
  await createUsersTable();
  await createModulesTable();
  await createUserPermissionsTable();
  await createUserAppAccessTable();
  await createTrainingVideosTable();
  await createModuleSopsTable();
  await createDepartmentsTable();
  await createDesignationsTable();
  await createActivityLogsTable();
  await createInboxTable();
  // await createUserAppPreferencesTable();
  await createCoreUpdatedAtTriggers();
};
