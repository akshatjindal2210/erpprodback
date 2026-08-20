/**
 * Serial segment for coil / SA UID formatting.
 * Prefer the 3rd segment of mrn_uid (prefix_mrn_serial…) over numeric serial_no,
 * which may drop leading zeros when stored as INTEGER.
 */
export function resolveSerialNoForUid({ serial_no, mrn_uid, uid } = {}) {
  const uidStr = String(mrn_uid || uid || "").trim();
  if (uidStr.includes("_")) {
    const parts = uidStr.split("_").filter(Boolean);
    if (parts.length >= 3) return parts[2];
  }
  if (serial_no != null && String(serial_no).trim() !== "") {
    return String(serial_no).trim();
  }
  return "0";
}
