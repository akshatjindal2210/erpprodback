import dbQuery from "../../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** hrms_attendance_log — raw punches (device + manual). */
export async function createAttendanceLogTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ATTENDANCE_LOG} (
      id                SERIAL PRIMARY KEY,
      employee_code     TEXT NOT NULL,
      name              TEXT,
      event_timestamp   TIMESTAMPTZ NOT NULL,
      status            TEXT,
      label             TEXT,
      auth_method       TEXT,
      sub_event_type    INTEGER,
      event_name        TEXT,
      attendance_status TEXT,
      card_reader_no    INTEGER,
      device_name       TEXT,
      source            TEXT NOT NULL DEFAULT 'device',
      created_by        TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_log_employee ON ${T.ATTENDANCE_LOG}(employee_code);
    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_log_event_ts ON ${T.ATTENDANCE_LOG}(event_timestamp DESC);
  `);
}
