import dbQuery from "../../../../../config/db/db.js";
import { createUsersTable } from "../tables/identity/user.table.js";
import { createModulesTable } from "../tables/identity/module.table.js";
import { createUserPermissionsTable } from "../tables/identity/user_permissions.table.js";
import { createUserAppAccessTable } from "../tables/identity/user_app_access.table.js";
import { createTrainingVideosTable } from "../tables/training/training_videos.table.js";
import { createModuleSopsTable } from "../tables/training/module_sops.table.js";
import { createDepartmentsTable } from "../tables/identity/department.table.js";
import { createDesignationsTable } from "../tables/identity/designation.table.js";
import { createActivityLogsTable } from "../tables/activity-logs/activity_log.table.js";
import { createInboxTable } from "../tables/notifications/inbox.table.js";
import { createPushSubscriptionTable } from "../tables/notifications/push_subscription.table.js";
import { createPushDeliveryLogTable } from "../tables/notifications/push_delivery_log.table.js";
// import { createUserAppPreferencesTable } from "../tables/configuration/user_app_preferences.table.js";
import { createCoreUpdatedAtTriggers } from "../tables/db/triggers.table.js";

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
  await createPushSubscriptionTable();
  await createPushDeliveryLogTable();
  // await createUserAppPreferencesTable();
  await createCoreUpdatedAtTriggers();

  // One-shot cleanup — remove after next prod deploy once these old tables are gone
  await dbQuery(`DROP TABLE IF EXISTS ims_activity_logs CASCADE`);
  await dbQuery(`DROP TABLE IF EXISTS task_users_logs CASCADE`);
};
