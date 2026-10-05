import dbQuery from "../../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createLeaveTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.LEAVE} (
      id          SERIAL PRIMARY KEY,
      emp_dcode   INTEGER NOT NULL,
      leave_type  TEXT NOT NULL,
      from_date   DATE NOT NULL,
      to_date     DATE NOT NULL,
      days        NUMERIC(4,1) NOT NULL,
      reason      TEXT NOT NULL,
      sup_by      TEXT,
      sup_at      TIMESTAMPTZ,
      hr_by       TEXT,
      hr_at       TIMESTAMPTZ,
      created_by  TEXT,
      updated_by  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_hrms_leave_emp_dcode ON ${T.LEAVE}(emp_dcode);
  `);
}
