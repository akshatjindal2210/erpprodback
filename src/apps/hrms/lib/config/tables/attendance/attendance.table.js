import dbQuery from "../../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";

/** Attendance — structure only. */
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
      entry_type       TEXT NOT NULL DEFAULT 'automatic',
      day_type         VARCHAR(5) DEFAULT 'FD',
      day_value        NUMERIC(3,1) DEFAULT 1,
      default_in       TIMESTAMPTZ,
      default_out      TIMESTAMPTZ,
      total_minutes    INTEGER,
      lunch            BOOLEAN NOT NULL DEFAULT FALSE,
      worked_minutes   INTEGER,
      ot_minutes       INTEGER,
      ot_approved      SMALLINT NOT NULL DEFAULT 0,
      ot_approved_by   TEXT,
      ot_approved_at   TIMESTAMPTZ,
      ot_remarks       TEXT,
      approval_status  TEXT,
      approval_remarks TEXT,
      created_by       TEXT,
      updated_by       TEXT,
      approved_by      TEXT,
      approved_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (emp_dcode, attendance_date)
    );
    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_date ON ${T.ATTENDANCE}(attendance_date DESC);
    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_emp_dcode ON ${T.ATTENDANCE}(emp_dcode);
  `);

  await applyTablePatches(dbQuery, T.ATTENDANCE, {
    renameColumns: [
      { from: "check_in", to: "in" },
      { from: "check_out", to: "out" },
      { from: "employee_code", to: "emp_dcode" },
      { from: "punch_minutes", to: "total_minutes" },
    ],
    dropColumns: ["status", "punch_count"],
    integerColumns: [{ name: "emp_dcode", purgeNonNumeric: true }],
  });

  await patchTableSchema(dbQuery, T.ATTENDANCE, {
    columns: [
      patchCol("day_type", "VARCHAR(5) DEFAULT 'FD'"),
      patchCol("day_value", "NUMERIC(3,1) DEFAULT 1"),
      patchCol("default_in", "TIMESTAMPTZ"),
      patchCol("default_out", "TIMESTAMPTZ"),
      patchCol("total_minutes", "INTEGER"),
      patchCol("lunch", "BOOLEAN NOT NULL DEFAULT FALSE"),
      patchCol("worked_minutes", "INTEGER"),
      patchCol("ot_minutes", "INTEGER"),
      patchCol("ot_approved", "SMALLINT NOT NULL DEFAULT 0"),
      patchCol("ot_approved_by", "TEXT"),
      patchCol("ot_approved_at", "TIMESTAMPTZ"),
      patchCol("ot_remarks", "TEXT"),
      patchCol("approval_status", "TEXT"),
      patchCol("approval_remarks", "TEXT"),
    ],
  });

  // Legacy reject: ot_approved=0 + by/remarks → mark as rejected (2)
  await dbQuery(`
    UPDATE ${T.ATTENDANCE}
    SET ot_approved = 2,
        ot_approved_at = COALESCE(ot_approved_at, updated_at, NOW())
    WHERE COALESCE(ot_minutes, 0) > 0
      AND COALESCE(ot_approved, 0) = 0
      AND NULLIF(TRIM(COALESCE(ot_approved_by, '')), '') IS NOT NULL
      AND NULLIF(TRIM(COALESCE(ot_remarks, '')), '') IS NOT NULL
  `);
}
