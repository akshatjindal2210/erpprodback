import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";

export async function createCoreUpdatedAtTriggers() {
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
    T.USERS,
    T.MODULES,
    T.USER_PERMISSIONS,
    T.USER_APP_ACCESS,
    T.TRAINING_VIDEOS,
    T.MODULE_SOPS,
    T.DEPARTMENTS,
    T.DESIGNATIONS,
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
