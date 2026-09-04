import dbQuery from "../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../config/db/dbTables.js";
import { formatHrmsDate, formatHrmsTime } from "./hrmsFormat.js";

/** Calendar day for punch grouping (device times are IST). */
export const HRMS_ATTENDANCE_TZ = "Asia/Kolkata";

/** DB stores A / B. Accepts A|B|day|night. */
export function normalizeShift(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (s === "B" || s === "NIGHT" || s === "N") return "B";
  if (s === "A" || s === "DAY" || s === "D") return "A";
  return "";
}

export function shiftDisplay(value) {
  const s = normalizeShift(value);
  if (s === "B") return "Night";
  if (s === "A") return "Day";
  return "";
}

export function isValidPunch(record) {
  if (!record?.employee_code || !String(record.employee_code).trim()) return false;
  if (!record?.event_timestamp) return false;
  const status = String(record.status ?? "");
  const eventName = String(record.event_name ?? "");
  if (/failed|mismatch/i.test(status) || /failed|mismatch/i.test(eventName)) return false;
  return true;
}

function formatPunchRow(row) {
  if (!row) return null;
  return {
    ...row,
    attendance_date_display: formatHrmsDate(row.attendance_date),
    check_in_display: row.check_in ? formatHrmsTime(row.check_in) : null,
    check_out_display: row.check_out ? formatHrmsTime(row.check_out) : null,
    shift_display: shiftDisplay(row.shift),
  };
}

/**
 * Upsert one hrms_attendance row.
 * entry_type: automatic (machine) | manual (HR form).
 * shift: A (Day) | B (Night).
 */
export async function upsertAttendanceRow({
  employee_code,
  name = null,
  attendance_date,
  shift = "A",
  check_in = null,
  check_out = null,
  punch_count = 0,
  status = "Present",
  entry_type = "automatic",
  approval_status = null,
  created_by = null,
  updated_by = null,
  approved_by = null,
  approved_at = null,
} = {}) {
  const code = String(employee_code || "").trim();
  const shiftCode = normalizeShift(shift);
  if (!code || !attendance_date || !shiftCode) return null;
  const type = String(entry_type || "").toLowerCase() === "manual" ? "manual" : "automatic";

  const rows = await dbQuery(
    `
    INSERT INTO ${T.ATTENDANCE} (
      employee_code, name, attendance_date, shift, check_in, check_out, punch_count,
      status, entry_type, approval_status, created_by, updated_by,
      approved_by, approved_at, updated_at
    ) VALUES (
      $1, $2, $3::date, $4, $5::timestamptz, $6::timestamptz, $7,
      $8, $9, $10, $11, $12, $13, $14::timestamptz, NOW()
    )
    ON CONFLICT (employee_code, attendance_date, shift) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, ${T.ATTENDANCE}.name),
      check_in = EXCLUDED.check_in,
      check_out = EXCLUDED.check_out,
      punch_count = EXCLUDED.punch_count,
      status = EXCLUDED.status,
      entry_type = EXCLUDED.entry_type,
      approval_status = EXCLUDED.approval_status,
      created_by = COALESCE(${T.ATTENDANCE}.created_by, EXCLUDED.created_by),
      updated_by = EXCLUDED.updated_by,
      approved_by = EXCLUDED.approved_by,
      approved_at = EXCLUDED.approved_at,
      updated_at = NOW()
    RETURNING
      id, employee_code, name, shift,
      to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
      (to_char(check_in AT TIME ZONE '${HRMS_ATTENDANCE_TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_in,
      (to_char(check_out AT TIME ZONE '${HRMS_ATTENDANCE_TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_out,
      punch_count, status, entry_type, approval_status
    `,
    [
      code,
      name != null && String(name).trim() !== "" ? String(name).trim() : null,
      attendance_date,
      shiftCode,
      check_in,
      check_out,
      Number(punch_count) || 0,
      status || "Present",
      type,
      approval_status,
      created_by,
      updated_by,
      approved_by,
      approved_at,
    ]
  );

  return formatPunchRow(rows[0] || null);
}

/** Remove provisional daily row when punch already lives in attendance-log. */
export async function clearProvisionalAttendance(employee_code, attendance_date, shift = null) {
  const code = String(employee_code || "").trim();
  if (!code || !attendance_date) return 0;
  const shiftCode = normalizeShift(shift);
  const rows = await dbQuery(
    shiftCode
      ? `
        DELETE FROM ${T.ATTENDANCE}
        WHERE employee_code = $1 AND attendance_date = $2::date AND shift = $3 AND approval_status IS NULL
        RETURNING id
      `
      : `
        DELETE FROM ${T.ATTENDANCE}
        WHERE employee_code = $1 AND attendance_date = $2::date AND approval_status IS NULL
        RETURNING id
      `,
    shiftCode ? [code, attendance_date, shiftCode] : [code, attendance_date]
  );
  return rows.length;
}
