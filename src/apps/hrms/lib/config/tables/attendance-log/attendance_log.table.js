import dbQuery from "../../../../../../config/db/db.js";
import { dropColumnIfExists } from "../../../../../../config/db/ensureDbColumns.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createAttendanceLogTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ATTENDANCE_LOG} (
      id                SERIAL PRIMARY KEY,
      employee_code     TEXT NOT NULL,
      name              TEXT,
      event_timestamp   TIMESTAMPTZ NOT NULL,
      status            TEXT,
      auth_method       TEXT,
      sub_event_type    INTEGER,
      event_name        TEXT,
      card_reader_no    INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_log_employee ON ${T.ATTENDANCE_LOG}(employee_code);
    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_log_event_ts ON ${T.ATTENDANCE_LOG}(event_timestamp DESC);
  `);

  await dropColumnIfExists(dbQuery, T.ATTENDANCE_LOG, "label");
  await dropColumnIfExists(dbQuery, T.ATTENDANCE_LOG, "attendance_status");
  await dropColumnIfExists(dbQuery, T.ATTENDANCE_LOG, "device_name");
  await dropColumnIfExists(dbQuery, T.ATTENDANCE_LOG, "source");
  await dropColumnIfExists(dbQuery, T.ATTENDANCE_LOG, "created_by");
}
