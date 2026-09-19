import dbQuery from "../../../../../../config/db/db.js";
import { applyTablePatches } from "../../../../../../config/db/ensureDbColumns.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createAttendanceTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ATTENDANCE} (
      id               SERIAL PRIMARY KEY,
      emp_dcode        INTEGER NOT NULL,
      name             TEXT,
      attendance_date  DATE NOT NULL,
      shift            TEXT NOT NULL DEFAULT 'A',
      "in"             TIMESTAMPTZ,
      "out"            TIMESTAMPTZ,
      punch_count      INTEGER NOT NULL DEFAULT 0,
      entry_type       TEXT NOT NULL DEFAULT 'automatic',
      approval_status  TEXT,
      created_by       TEXT,
      updated_by       TEXT,
      approved_by      TEXT,
      approved_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (emp_dcode, attendance_date)
    );
    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_date ON ${T.ATTENDANCE}(attendance_date DESC);
  `);

  await applyTablePatches(dbQuery, T.ATTENDANCE, {
    renameColumns: [
      { from: "check_in", to: "in" },
      { from: "check_out", to: "out" },
      { from: "employee_code", to: "emp_dcode" },
    ],
    dropColumns: ["status"],
    integerColumns: [{ name: "emp_dcode", purgeNonNumeric: true }],
    indexes: [`CREATE INDEX IF NOT EXISTS idx_hrms_attendance_emp_dcode ON ${T.ATTENDANCE}(emp_dcode)`],
    logPrefix: "[HRMS] attendance emp_dcode → INTEGER:",
  });
}
