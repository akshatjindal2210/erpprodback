export const HRMS_ATTENDANCE_TZ = "Asia/Kolkata";

/** Quoted DB/API field names — `in` / `out` are reserved in SQL. */
export const ATT_COL_IN = '"in"';
export const ATT_COL_OUT = '"out"';

export function rowInTime(row) {
  return row?.in ?? null;
}

export function rowOutTime(row) {
  return row?.out ?? null;
}

export function istTs(column) {
  return `(to_char(${column} AT TIME ZONE '${HRMS_ATTENDANCE_TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30')`;
}

export const LOG_DATE_SQL = `(event_timestamp AT TIME ZONE '${HRMS_ATTENDANCE_TZ}')::date`;

export const LOG_VALID_PUNCH_SQL = `
  employee_code IS NOT NULL AND TRIM(employee_code) <> ''
  AND event_timestamp IS NOT NULL
  AND deleted_at IS NULL
  AND COALESCE(status, '') NOT ILIKE '%failed%'
  AND COALESCE(status, '') NOT ILIKE '%mismatch%'
  AND COALESCE(event_name, '') NOT ILIKE '%failed%'
  AND COALESCE(event_name, '') NOT ILIKE '%mismatch%'
`;

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

export function countPunches(inTime = null, outTime = null) {
  let n = 0;
  if (inTime) n += 1;
  if (outTime) n += 1;
  return n;
}

export function ymd(value) {
  const s = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

export function istNowDate() {
  // Keep all attendance date validations in IST, independent of server timezone.
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

export function isFutureAttendanceDate(value) {
  const d = ymd(value);
  if (!d) return false;
  return d > istNowDate();
}

export function isFutureAttendanceDateTime(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

export function timeKey(value) {
  if (value == null || String(value).trim() === "") return "";
  const s = String(value).trim();
  const iso = s.match(/T(\d{2}):(\d{2})/i);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const plain = s.match(/^(\d{1,2}):(\d{2})/);
  if (plain) return `${String(plain[1]).padStart(2, "0")}:${plain[2]}`;
  return s;
}

function dateTimeKey(value) {
  if (value == null || String(value).trim() === "") return "";
  const s = String(value).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2}).*?(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}T${iso[2]}:${iso[3]}`;
  const hm = timeKey(s);
  return hm ? `T${hm}` : "";
}

export function toIstTimestamp(date, time) {
  if (time == null || String(time).trim() === "") return null;
  const raw = String(time).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    // datetime-local input can come without timezone; treat it as IST.
    if (/[zZ]$|[+\-]\d{2}:\d{2}$/.test(raw)) return raw;
    return /\d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw}+05:30` : `${raw}:00+05:30`;
  }
  const hm = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!hm || !date) return null;
  return `${date}T${String(hm[1]).padStart(2, "0")}:${hm[2]}:00+05:30`;
}

function isFullTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(String(value ?? "").trim());
}

export function addDaysYmd(dateStr, days) {
  const base = ymd(dateStr);
  if (!base) return dateStr;
  const d = new Date(`${base}T12:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return base;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** HH:MM out before in on same day → next day (night shift). Full timestamps kept as-is. */
export function resolveInOutTimestamps(attendanceDate, inRaw, outRaw) {
  const date = ymd(attendanceDate);
  const inTs = toIstTimestamp(date, inRaw);
  let outTs = toIstTimestamp(date, outRaw);
  if (
    date &&
    inTs &&
    outTs &&
    !isFullTimestamp(inRaw) &&
    !isFullTimestamp(outRaw) &&
    timeKey(outTs) <= timeKey(inTs)
  ) {
    outTs = toIstTimestamp(addDaysYmd(date, 1), outRaw);
  }
  return { in: inTs, out: outTs };
}

export function punchFingerprint(row) {
  return [dateTimeKey(rowInTime(row)), dateTimeKey(rowOutTime(row)), normalizeShift(row?.shift) || "A"].join("|");
}

export function parseAttendanceInOut(raw = {}, previous = {}, date = "") {
  const attDate = ymd(date) || ymd(previous?.attendance_date);
  const inRaw = raw.in ?? rowInTime(previous);
  const outRaw = raw.out ?? rowOutTime(previous);
  return resolveInOutTimestamps(attDate, inRaw, outRaw);
}

export function normalizeEntryType(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "manual") return "manual";
  if (s === "automatic_edit") return "automatic_edit";
  return "automatic";
}

export function entryTypeDisplay(value) {
  const s = normalizeEntryType(value);
  if (s === "automatic_edit") return "Automatic Edit";
  if (s === "manual") return "Manual";
  return "Automatic";
}

export function resolveEntryTypeOnUpdate(previous, changed) {
  const prev = normalizeEntryType(previous?.entry_type);
  if (prev === "manual") return "manual";
  if (changed) return "automatic_edit";
  return prev === "automatic_edit" ? "automatic_edit" : "automatic";
}

export function parseEmpDcode(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

export function buildAttendanceParams(row = {}) {
  const empDcode = parseEmpDcode(row.emp_dcode);
  const shift = normalizeShift(row.shift);
  if (!empDcode || !row.attendance_date || !shift) return null;
  const entryType = normalizeEntryType(row.entry_type);
  return [
    empDcode,
    row.name != null && String(row.name).trim() !== "" ? String(row.name).trim() : null,
    row.attendance_date,
    shift,
    rowInTime(row) ?? null,
    rowOutTime(row) ?? null,
    Number(row.punch_count) || countPunches(rowInTime(row), rowOutTime(row)),
    entryType,
    row.approval_status ?? null,
    row.created_by ?? null,
    row.updated_by ?? null,
    row.approved_by ?? null,
    row.approved_at ?? null,
  ];
}

export function isApprovedStatus(value) {
  return String(value ?? "").trim().toLowerCase() === "approved";
}
