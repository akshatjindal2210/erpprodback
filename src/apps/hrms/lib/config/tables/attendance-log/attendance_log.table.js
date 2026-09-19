import dbQuery from "../../../../../../config/db/db.js";
import { applyTablePatches, patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";
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
      deleted_at        TIMESTAMPTZ,
      deleted_by        TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_log_employee ON ${T.ATTENDANCE_LOG}(employee_code);
    CREATE INDEX IF NOT EXISTS idx_hrms_attendance_log_event_ts ON ${T.ATTENDANCE_LOG}(event_timestamp DESC);
  `);

  await applyTablePatches(dbQuery, T.ATTENDANCE_LOG, {
    dropColumns: ["label", "attendance_status", "device_name", "source", "created_by"],
  });

  await patchTableSchema(dbQuery, T.ATTENDANCE_LOG, {
    columns: [patchCol("deleted_at", "TIMESTAMPTZ"), patchCol("deleted_by", "TEXT")],
    indexes: [`CREATE INDEX IF NOT EXISTS idx_hrms_attendance_log_active ON ${T.ATTENDANCE_LOG}(event_timestamp DESC) WHERE deleted_at IS NULL`],
  });
}
