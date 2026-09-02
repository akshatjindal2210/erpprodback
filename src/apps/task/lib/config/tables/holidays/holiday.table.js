import dbQuery from "../../../shared/db.js";
import { patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";
import { TASK_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createTaskHolidayTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.HOLIDAY} (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      date       DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  /** Holidays unique by calendar date (same name allowed in different years). */
  await dbQuery(`ALTER TABLE ${T.HOLIDAY} DROP CONSTRAINT IF EXISTS task_holiday_name_key`);
  await patchTableSchema(dbQuery, T.HOLIDAY, {
    indexes: [
      `DROP INDEX IF EXISTS task_holiday_name_key`,
      `CREATE UNIQUE INDEX IF NOT EXISTS task_holiday_date_key ON ${T.HOLIDAY} (date)`,
    ],
  });
}
