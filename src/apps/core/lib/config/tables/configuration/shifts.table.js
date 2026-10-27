import dbQuery from "../../../../../../config/db/db.js";
import { MST_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createShiftsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.SHIFTS} (
      id          SERIAL PRIMARY KEY,
      code        VARCHAR(20) NOT NULL,
      start_time  TIME NOT NULL,
      end_time    TIME NOT NULL,
      is_active   BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS mst_shifts_code_lower_unique
    ON ${T.SHIFTS} (LOWER(TRIM(code)));
  `);
}
