import dbQuery from "../../shared/db.js";
import { TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskUpdatedAtTriggers() {
  await dbQuery(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  const tables = [
    T.CATEGORIES,
    T.HOLIDAY,
    T.TASKS,
    T.RECURRING_TASKS,
    T.RECURRING_TASK_ASSIGNMENTS,
    T.RECURRING_TASK_CHAT,
    T.ASSIGNMENTS,
    T.CHAT,
    T.SELF_NOTES,
    T.APP_CONFIG,
  ];

  for (const table of tables) {
    await dbQuery(`DROP TRIGGER IF EXISTS tr_${table}_updated_at ON ${table}`);
    await dbQuery(`
      CREATE TRIGGER tr_${table}_updated_at
      BEFORE UPDATE ON ${table}
      FOR EACH ROW
      EXECUTE PROCEDURE set_updated_at();
    `);
  }
}
