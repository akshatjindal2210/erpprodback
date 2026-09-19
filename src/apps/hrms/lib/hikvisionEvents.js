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

/** Hikvision ACS snap — usual field is AccessControllerEvent.pictureURL. */
export function extractDeviceEventImage(event) {
  const acs = event?.AccessControllerEvent || event;
  if (!acs || typeof acs !== "object") return "";
  for (const key of ["pictureURL", "picURL", "snapURL"]) {
    const url = String(acs[key] ?? "").trim();
    if (url) return url;
  }
  return "";
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
