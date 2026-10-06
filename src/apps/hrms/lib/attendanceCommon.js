/**
 * ═══════════════════════════════════════════════════════════
 *  HRMS ATTENDANCE — ALL FORMULAS (change HERE only)
 *  UI mirror: frontend/.../attendanceUtils.js → rowTotals()
 * ═══════════════════════════════════════════════════════════
 *
 * CUTOFFS (IST)
 *   Night start = 17:00   (NIGHT_SHIFT_FROM)
 *   Night end   = 08:00   (NIGHT_SHIFT_END)
 *   Lunch       = punch ≥ 4 hours → deduct 30 min
 *   OT buffer   = Settings → HRMS → hrms_overtime_buffer_minutes
 *                 (default 30, range 10–120) — Full day only
 *
 * SHIFT / PUNCH
 *   First punch ≥ 17:00 → Shift B (Night)
 *     In  = that punch
 *     Out = next-day first punch before 08:00
 *           else force Out = next day 08:00 (HR can Edit)
 *   First punch < 17:00 → Shift A (Day)
 *     In / Out = same calendar day (first / last punch)
 *   Same-day punch before 08:00 → ignore (belongs to previous night)
 *
 * HOURS
 *   total_minutes  = In → Out
 *   lunch          = true if total ≥ 240 (−30 when true)
 *   worked_minutes = total − lunch
 *
 * OT (ot_minutes)
 *   Full (FD) = (Out − default_out) − buffer
 *               (early Out → negative; buffer only on positive OT)
 *   Half (HD) = excess over Normal half-day only (no buffer)
 *   + OT → OT Approval pending (ot_approved: 0 pending | 1 approved | 2 rejected)
 *   − OT → System auto-approve
 *   After approve/reject → only super_admin may change decision
 *
 * DEFAULTS (TIMESTAMPTZ)
 *   default_in / default_out from emp master times + attendance_date
 *   Night Out date = next day when Out time < In time
 *
 * KEY FUNCTIONS
 *   buildLogDailyPunchSql      punch → In / Out / Shift
 *   applyNightDefaultOut       missing/late night Out → 08:00
 *   buildDefaultInOutTimestamps
 *   computeAttendanceDerived   total + lunch + worked + OT + approve state
 *   buildAttendanceParams      pack for DB save
 * ═══════════════════════════════════════════════════════════
 */

export const HRMS_ATTENDANCE_TZ = "Asia/Kolkata";
export const NIGHT_SHIFT_FROM = "17:00";
export const NIGHT_SHIFT_END = "08:00";
export const LUNCH_MINUTES = 30;
export const LUNCH_THRESHOLD_MINUTES = 4 * 60;
export const ATT_COL_IN = '"in"';
export const ATT_COL_OUT = '"out"';

export const LOG_DATE_SQL = `(event_timestamp AT TIME ZONE '${HRMS_ATTENDANCE_TZ}')::date`;

const LOG_VALID = `
  employee_code IS NOT NULL AND TRIM(employee_code) <> ''
  AND event_timestamp IS NOT NULL AND deleted_at IS NULL
  AND COALESCE(status, '') NOT ILIKE '%failed%' AND COALESCE(status, '') NOT ILIKE '%mismatch%'
  AND COALESCE(event_name, '') NOT ILIKE '%failed%' AND COALESCE(event_name, '') NOT ILIKE '%mismatch%'
`;

export function rowInTime(row) { return row?.in ?? null; }
export function rowOutTime(row) { return row?.out ?? null; }

export function istTs(column) {
  return `(to_char(${column} AT TIME ZONE '${HRMS_ATTENDANCE_TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30')`;
}

export function ymd(value) {
  const s = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

export function istNowDate() {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

export function isFutureAttendanceDate(value) {
  const d = ymd(value);
  return Boolean(d && d > istNowDate());
}

export function addDaysYmd(dateStr, days) {
  const base = ymd(dateStr);
  if (!base) return dateStr;
  const d = new Date(`${base}T12:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return base;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function normalizeShift(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (s === "B" || s === "NIGHT" || s === "N") return "B";
  if (s === "A" || s === "DAY" || s === "D") return "A";
  return "";
}

export function shiftDisplay(value) {
  const s = normalizeShift(value);
  return s === "B" || s === "A" ? s : "";
}

export function parseEmpDcode(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

export function isApprovedStatus(value) {
  return String(value ?? "").trim().toLowerCase() === "approved";
}

/** OT decision: 0 pending | 1 approved | 2 rejected */
export function normalizeOtApprovedFlag(value) {
  const n = Number(value);
  if (n === 1 || value === true || value === "1") return 1;
  if (n === 2 || value === "2") return 2;
  return 0;
}

export function otDecisionLabel(value) {
  const n = normalizeOtApprovedFlag(value);
  if (n === 1) return "Approved";
  if (n === 2) return "Rejected";
  return "Pending";
}

export const DAY_TYPE_MASTER = {
  FD: { name: "Full", value: 1 },
  HD: { name: "Half", value: 0.5 },
};

export function normalizeDayType(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (s === "HD" || s === "HALF") return "HD";
  if (s === "FD" || s === "FULL" || !s) return "FD";
  return DAY_TYPE_MASTER[s] ? s : "FD";
}

export function dayTypeDisplay(value) {
  return DAY_TYPE_MASTER[normalizeDayType(value)]?.name || normalizeDayType(value);
}

export function dayTypeValue(value) {
  return Number(DAY_TYPE_MASTER[normalizeDayType(value)]?.value ?? 1);
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

export function timeKey(value) {
  if (value == null || String(value).trim() === "") return "";
  const s = String(value).trim();
  const iso = s.match(/T(\d{2}):(\d{2})/i);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const plain = s.match(/^(\d{1,2}):(\d{2})/);
  if (plain) return `${String(plain[1]).padStart(2, "0")}:${plain[2]}`;
  return s;
}

export function toIstTimestamp(date, time) {
  if (time == null || String(time).trim() === "") return null;
  const raw = String(time).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    if (/[zZ]$|[+\-]\d{2}:\d{2}$/.test(raw)) return raw;
    return /\d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw}+05:30` : `${raw}:00+05:30`;
  }
  const hm = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!hm || !date) return null;
  return `${date}T${String(hm[1]).padStart(2, "0")}:${hm[2]}:00+05:30`;
}

function hhmm(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  const iso = s.match(/(?:T|\s)(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const plain = s.match(/^(\d{1,2}):(\d{2})/);
  if (plain) return `${String(plain[1]).padStart(2, "0")}:${plain[2]}`;
  return "";
}

function minutesBetweenTs(a, b) {
  const start = Date.parse(a);
  const end = Date.parse(b);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 60000);
}

function asIstTimestamp(value) {
  let s = String(value ?? "").trim();
  if (!s || !/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  if (!/[zZ]$|[+\-]\d{2}:\d{2}$/.test(s)) {
    s = /\d{2}:\d{2}:\d{2}/.test(s) ? `${s}+05:30` : `${s}:00+05:30`;
  }
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

/** Device log → In/Out/Shift ($1 = attendance_date) */
export function buildLogDailyPunchSql(logTable) {
  return `
  WITH day_eligible AS (
    SELECT employee_code, name, event_timestamp,
      (event_timestamp AT TIME ZONE '${HRMS_ATTENDANCE_TZ}')::time AS punch_time
    FROM ${logTable}
    WHERE ${LOG_VALID}
      AND ${LOG_DATE_SQL} = $1::date
      AND (event_timestamp AT TIME ZONE '${HRMS_ATTENDANCE_TZ}')::time >= TIME '${NIGHT_SHIFT_END}'
  ),
  next_day_out AS (
    SELECT employee_code, MIN(event_timestamp) AS first_out
    FROM ${logTable}
    WHERE ${LOG_VALID}
      AND ${LOG_DATE_SQL} = ($1::date + 1)
      AND (event_timestamp AT TIME ZONE '${HRMS_ATTENDANCE_TZ}')::time < TIME '${NIGHT_SHIFT_END}'
    GROUP BY employee_code
  ),
  agg AS (
    SELECT d.employee_code,
      MAX(d.name) FILTER (WHERE NULLIF(TRIM(d.name), '') IS NOT NULL) AS name,
      MIN(d.event_timestamp) AS first_punch,
      MAX(d.event_timestamp) AS last_punch,
      COUNT(*)::int AS punch_n,
      MIN(d.punch_time) AS first_time
    FROM day_eligible d
    GROUP BY d.employee_code
  )
  SELECT a.employee_code, a.name,
    ${istTs("a.first_punch")} AS "in",
    ${istTs(`CASE
      WHEN a.first_time >= TIME '${NIGHT_SHIFT_FROM}' THEN n.first_out
      WHEN a.punch_n > 1 THEN a.last_punch
      ELSE NULL
    END`)} AS "out",
    CASE WHEN a.first_time >= TIME '${NIGHT_SHIFT_FROM}' THEN 'B' ELSE 'A' END AS shift
  FROM agg a
  LEFT JOIN next_day_out n USING (employee_code)
`;
}

/** Night B, no Out before 08:00 → next day 08:00 */
export function applyNightDefaultOut(punch, attendanceDate) {
  if (normalizeShift(punch?.shift) !== "B" || !rowInTime(punch) || rowOutTime(punch)) return punch;
  const date = ymd(attendanceDate);
  if (!date) return punch;
  return { ...punch, out: `${addDaysYmd(date, 1)}T${NIGHT_SHIFT_END}:00+05:30`, out_defaulted: true };
}

export function resolveInOutTimestamps(attendanceDate, inRaw, outRaw) {
  const date = ymd(attendanceDate);
  const inTs = toIstTimestamp(date, inRaw);
  let outTs = toIstTimestamp(date, outRaw);
  const full = (v) => /^\d{4}-\d{2}-\d{2}T/.test(String(v ?? "").trim());
  if (date && inTs && outTs && !full(inRaw) && !full(outRaw) && timeKey(outTs) <= timeKey(inTs)) {
    outTs = toIstTimestamp(addDaysYmd(date, 1), outRaw);
  }
  return { in: inTs, out: outTs };
}

export function parseAttendanceInOut(raw = {}, previous = {}, date = "") {
  return resolveInOutTimestamps(
    ymd(date) || ymd(previous?.attendance_date),
    raw.in ?? rowInTime(previous),
    raw.out ?? rowOutTime(previous)
  );
}

export function punchFingerprint(row) {
  return [dateTimeKey(rowInTime(row)), dateTimeKey(rowOutTime(row)), normalizeShift(row?.shift) || "A"].join("|");
}

/** Default In/Out TIMESTAMPTZ */
export function buildDefaultInOutTimestamps(attendanceDate, shift, inRaw, outRaw) {
  const date = ymd(attendanceDate);
  const din = hhmm(inRaw);
  const dout = hhmm(outRaw);
  if (!date) return { default_in: null, default_out: null };
  const default_in = din ? `${date}T${din}:00+05:30` : null;
  if (!dout) return { default_in, default_out: null };
  const inMins = din ? Number(din.slice(0, 2)) * 60 + Number(din.slice(3, 5)) : null;
  const outMins = Number(dout.slice(0, 2)) * 60 + Number(dout.slice(3, 5));
  const night = normalizeShift(shift) === "B";
  const cross = inMins != null && outMins < inMins;
  const sameDay = inMins != null && outMins >= inMins;
  const outDate = cross || (night && !sameDay) ? addDaysYmd(date, 1) : date;
  return { default_in, default_out: `${outDate}T${dout}:00+05:30` };
}

export function defaultOutDateTime(row) {
  return asIstTimestamp(row?.default_out)
    || buildDefaultInOutTimestamps(row?.attendance_date, row?.shift, row?.default_in, row?.default_out).default_out;
}

function defaultSpanMinutes(row) {
  const a = asIstTimestamp(row?.default_in)
    || buildDefaultInOutTimestamps(row?.attendance_date, row?.shift, row?.default_in, row?.default_out).default_in;
  const b = defaultOutDateTime(row);
  return a && b ? minutesBetweenTs(a, b) : null;
}

export function computeTotalMinutes(row = {}) {
  const a = rowInTime(row);
  const b = rowOutTime(row);
  if (!a || !b) return null;
  return minutesBetweenTs(a, b);
}

export function computeLunch(row = {}) {
  const total = typeof row === "number" ? row : computeTotalMinutes(row);
  return total != null && total >= LUNCH_THRESHOLD_MINUTES;
}

export function computeWorkedMinutes(row = {}) {
  const total = computeTotalMinutes(row);
  if (total == null) return null;
  return Math.max(0, total - (computeLunch(total) ? LUNCH_MINUTES : 0));
}

/** OT: Full = after default Out − buffer; Half = excess over Normal */
export function computeOtMinutes(row = {}, overtimeBufferMinutes = 0) {
  const buf = Number(overtimeBufferMinutes);
  const buffer = Number.isFinite(buf) && buf > 0 ? buf : 0;

  if (normalizeDayType(row.day_type) === "HD") {
    const punch = computeTotalMinutes(row);
    if (punch != null) {
      const worked = Math.max(0, punch - (punch >= LUNCH_THRESHOLD_MINUTES ? LUNCH_MINUTES : 0));
      const full = defaultSpanMinutes(row);
      const expected = full == null ? null : Math.max(0, full - LUNCH_MINUTES) / 2 + LUNCH_MINUTES;
      const normalCap = expected == null ? null : Math.max(0, expected - LUNCH_MINUTES);
      if (normalCap != null) {
        const excess = Math.max(0, worked - normalCap);
        if (excess > 0) return Math.round(excess);
      }
    }
  }

  const outRaw = rowOutTime(row);
  const defaultOutDt = defaultOutDateTime(row);
  if (!outRaw || !defaultOutDt) return null;
  let outDt = String(outRaw).trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(outDt)) {
    const date = ymd(row.attendance_date);
    const hm = hhmm(outDt);
    if (!date || !hm) return null;
    outDt = `${date}T${hm}:00+05:30`;
  } else if (!/[zZ]$|[+\-]\d{2}:\d{2}$/.test(outDt)) {
    outDt = /\d{2}:\d{2}:\d{2}/.test(outDt) ? `${outDt}+05:30` : `${outDt}:00+05:30`;
  }
  const delta = minutesBetweenTs(defaultOutDt, outDt);
  if (delta == null) return null;
  return delta > 0 ? delta - buffer : delta;
}

/** + OT pending; − OT System auto */
export function resolveOtApprovalState(otMinutes) {
  const n = otMinutes != null && Number.isFinite(Number(otMinutes)) ? Math.round(Number(otMinutes)) : null;
  if (n != null && n < 0) {
    return {
      ot_approved: 1,
      ot_approved_by: "System",
      ot_approved_at: new Date(),
      ot_remarks: "Auto-approved (negative OT)",
    };
  }
  return { ot_approved: 0, ot_approved_by: null, ot_approved_at: null, ot_remarks: null };
}

/** Save: defaults + total + lunch + worked + OT */
export function computeAttendanceDerived(row = {}, overtimeBufferMinutes = 0) {
  const shift = normalizeShift(row.shift) || "A";
  const dayType = normalizeDayType(row.day_type);
  const defaults = buildDefaultInOutTimestamps(ymd(row.attendance_date), shift, row.default_in, row.default_out);
  const withDefaults = {
    ...row,
    shift,
    day_type: dayType,
    day_value: row.day_value != null && Number.isFinite(Number(row.day_value))
      ? Number(row.day_value)
      : dayTypeValue(dayType),
    default_in: defaults.default_in,
    default_out: defaults.default_out,
  };
  const total_minutes = computeTotalMinutes(withDefaults);
  const lunch = computeLunch(total_minutes);
  const ot_minutes = computeOtMinutes(withDefaults, overtimeBufferMinutes);
  return {
    ...withDefaults,
    total_minutes,
    lunch,
    worked_minutes: total_minutes == null ? null : Math.max(0, total_minutes - (lunch ? LUNCH_MINUTES : 0)),
    ot_minutes,
    ...resolveOtApprovalState(ot_minutes),
  };
}

/** Pack DB params (row should already be from computeAttendanceDerived) */
export function buildAttendanceParams(row = {}) {
  const empDcode = parseEmpDcode(row.emp_dcode);
  const shift = normalizeShift(row.shift);
  if (!empDcode || !row.attendance_date || !shift) return null;
  const dayType = normalizeDayType(row.day_type);
  return [
    empDcode,
    row.name != null && String(row.name).trim() !== "" ? String(row.name).trim() : null,
    row.attendance_date,
    shift,
    rowInTime(row) ?? null,
    rowOutTime(row) ?? null,
    normalizeEntryType(row.entry_type),
    row.approval_status ?? null,
    row.created_by ?? null,
    row.updated_by ?? null,
    row.approved_by ?? null,
    row.approved_at ?? null,
    dayType,
    row.day_value != null && Number.isFinite(Number(row.day_value)) ? Number(row.day_value) : dayTypeValue(dayType),
    asIstTimestamp(row.default_in) || row.default_in || null,
    asIstTimestamp(row.default_out) || row.default_out || null,
    row.worked_minutes ?? null,
    row.total_minutes ?? null,
    row.lunch === true || row.lunch === 1 || row.lunch === "1" || row.lunch === "t",
    row.ot_minutes ?? null,
    normalizeOtApprovedFlag(row.ot_approved),
    row.ot_approved_by ?? null,
    row.ot_approved_at ?? null,
    row.ot_remarks ?? null,
  ];
}
