import dbQuery from "../../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** hrms_attendance — daily sheet. entry_type: automatic|manual. shift: A=Day, B=Night. */
export async function createAttendanceTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ATTENDANCE} (
      id               SERIAL PRIMARY KEY,
      employee_code    TEXT NOT NULL,
      name             TEXT,
      attendance_date  DATE NOT NULL,
      shift            TEXT NOT NULL DEFAULT 'A',
      check_in         TIMESTAMPTZ,
      check_out        TIMESTAMPTZ,
      punch_count      INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'Present',
      entry_type       TEXT NOT NULL DEFAULT 'automatic',
      approval_status  TEXT,
      created_by       TEXT,
      updated_by       TEXT,
      approved_by      TEXT,
      approved_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (employee_code, attendance_date, shift)
    );

    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_employee ON ${T.ATTENDANCE}(employee_code);
    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_date ON ${T.ATTENDANCE}(attendance_date DESC);
  `);
}
