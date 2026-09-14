export const TRAY_STATUSES = Object.freeze(["active", "inactive", "deleted"]);

export function normalizeTrayStatus(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "discard" || raw === "discarded") return "inactive";
  return raw;
}

export function isValidTrayStatus(value) {
  return TRAY_STATUSES.includes(normalizeTrayStatus(value));
}

export function isTrayUsableStatus(value) {
  return normalizeTrayStatus(value) === "active";
}

export function isTrayHeldStatus(value) {
  return normalizeTrayStatus(value) === "inactive";
}

/** Legacy rows may still store status = discard in DB. */
export const TRAY_HELD_SQL = "('inactive', 'discard')";
