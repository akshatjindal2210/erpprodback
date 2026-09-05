import dbQuery from "../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../config/db/dbTables.js";
import { HRMS_ATTENDANCE_TZ } from "./attendanceDaily.js";

/** Device wall-clock (IST) — matches Hikvision dateTime. */
export const EVENT_TS_SQL = `(to_char(event_timestamp AT TIME ZONE '${HRMS_ATTENDANCE_TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30')`;
export const CREATED_AT_SQL = `(to_char(created_at AT TIME ZONE '${HRMS_ATTENDANCE_TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30')`;

const EVENT_CODES = {
  1: { auth: "Authenticated via Card", name: "Valid Card Authentication Completed", ok: true },
  38: { auth: "Authenticated via Fingerprint", name: "Fingerprint Matched", ok: true },
  39: { auth: "Fingerprint Failed", name: "Fingerprint Mismatched", ok: false },
  75: { auth: "Authenticated via Face", name: "Face Authentication Completed", ok: true },
  76: { auth: "Face Authentication Failed", name: "Face Authentication Failed", ok: false },
  80: { auth: "Face Recognition Failed", name: "Face Recognition Failed", ok: false },
  104: { auth: "Human Detection Failed", name: "Human Detection Failed", ok: false },
};

const ATTENDANCE = { checkIn: "In", checkOut: "Out", breakIn: "Gatepass In", breakOut: "Gatepass Out" };

function parseJson(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    try {
      return JSON.parse(value.trim());
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? value : null;
}

function statusOf(acs, code) {
  const label = String(acs.label ?? "").trim();
  if (label) return label;
  if (acs.attendanceStatus && ATTENDANCE[acs.attendanceStatus]) return ATTENDANCE[acs.attendanceStatus];
  if (code?.ok === false) return code.name;
  if (acs.onlyVerify === true) return "Verify Only";
  if (code?.ok === true) return "OK";
  return null;
}

export function deviceEventToRecord(event) {
  if (!event || String(event.eventType || "").toLowerCase() === "heartbeat") return null;
  const acs = event.AccessControllerEvent || event;
  const employeeCode = acs.employeeNoString ?? acs.employeeNo;
  const name = acs.name;
  if (!employeeCode && !name) return null;
  const subEventType = acs.subEventType ?? acs.minor;
  const code = EVENT_CODES[Number(subEventType)] || null;
  return {
    employee_code: String(employeeCode ?? ""),
    name: String(name ?? ""),
    sub_event_type: subEventType ?? null,
    event_name: code?.name || `Unknown Code ${subEventType}`,
    card_reader_no: acs.cardReaderNo ?? null,
    auth_method: code?.auth || `Access Event (${subEventType})`,
    attendance_status: acs.attendanceStatus || null,
    label: String(acs.label ?? "").trim() || null,
    status: statusOf(acs, code),
    device_name: acs.deviceName || null,
    event_timestamp: event.dateTime || acs.dateTime || acs.time || event.time || null,
    source: "device",
  };
}

export function extractDeviceEvents(body) {
  const parsed = parseJson(body) || body;
  if (parsed?.AccessControllerEvent && !Array.isArray(parsed.AccessControllerEvent)) return [parsed];
  const out = [];
  function push(value) {
    const item = parseJson(value);
    if (!item) return;
    if (Array.isArray(item)) return item.forEach(push);
    if (item.AcsEvent) return push(item.AcsEvent);
    if (Array.isArray(item.EventList)) return item.EventList.forEach(push);
    if (Array.isArray(item.InfoList)) return item.InfoList.forEach(push);
    if (Array.isArray(item.AccessControllerEvent)) {
      return item.AccessControllerEvent.forEach((acs) => push({ ...item, AccessControllerEvent: acs }));
    }
    if (item.AccessControllerEvent || item.eventType || item.employeeNoString) out.push(item);
  }
  if (parsed && typeof parsed === "object") Object.keys(parsed).forEach((key) => push(parsed[key]));
  return out;
}

export function manualMarkToRecord({ employee_code, name, mark_type, device_name, marked_by }) {
  const code = String(employee_code ?? "").trim();
  if (!code) return null;
  const iso = new Date().toISOString();
  const mark = String(mark_type ?? "").toLowerCase();
  const attendanceStatus = mark === "out" || mark === "checkout" ? "checkOut" : "checkIn";
  const status = attendanceStatus === "checkOut" ? ATTENDANCE.checkOut : ATTENDANCE.checkIn;
  return {
    employee_code: code,
    name: String(name ?? "").trim(),
    sub_event_type: null,
    event_name: "Manual Mark",
    card_reader_no: null,
    auth_method: "Manual",
    attendance_status: attendanceStatus,
    label: status,
    status,
    device_name: device_name ? String(device_name).trim() : "Portal",
    event_timestamp: iso,
    source: "manual",
    created_by: marked_by || null,
  };
}

const INSERT_RETURNING = `
  RETURNING id, employee_code, name, sub_event_type, event_name, card_reader_no,
    auth_method, attendance_status, label, status, device_name, source, created_by,
    ${EVENT_TS_SQL} AS event_timestamp,
    ${CREATED_AT_SQL} AS created_at
`;

export async function insertAttendanceLogRecord(record) {
  const exists = await dbQuery(
    `SELECT id FROM ${T.ATTENDANCE_LOG}
     WHERE employee_code = $1
       AND event_timestamp = $2::timestamptz
       AND COALESCE(sub_event_type, 0) = COALESCE($3, 0)
     LIMIT 1`,
    [record.employee_code, record.event_timestamp, record.sub_event_type]
  );
  if (exists.length) return null;
  const rows = await dbQuery(
    `INSERT INTO ${T.ATTENDANCE_LOG} (
      employee_code, name, sub_event_type, event_name, card_reader_no,
      auth_method, attendance_status, label, status, device_name,
      event_timestamp, source, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12,$13)
    ${INSERT_RETURNING}`,
    [
      record.employee_code, record.name, record.sub_event_type, record.event_name,
      record.card_reader_no, record.auth_method, record.attendance_status, record.label,
      record.status, record.device_name, record.event_timestamp,
      record.source || "device", record.created_by || null,
    ]
  );
  // Automatic / device punches live only in attendance-log — do not mirror into hrms_attendance.
  return rows[0];
}

export async function saveHikvisionEventsFromBody(body) {
  const saved = [];
  for (const event of extractDeviceEvents(body)) {
    const record = deviceEventToRecord(event);
    if (!record) continue;
    const row = await insertAttendanceLogRecord(record);
    if (row) saved.push(row);
  }
  return saved;
}

export { ATTENDANCE };
