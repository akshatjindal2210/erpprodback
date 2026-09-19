import { createAttendanceLogTable } from "../tables/attendance-log/attendance_log.table.js";
import { createAttendanceTable } from "../tables/attendance/attendance.table.js";
import { createGatePassTable } from "../tables/gate-pass/gate_pass.table.js";

export async function initHrmsDB() {
  await createAttendanceLogTable();
  await createAttendanceTable();
  await createGatePassTable();
}
