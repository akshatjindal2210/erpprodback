export const TRAY_STATUSES = Object.freeze(["active", "inactive"]);

export const TRAY_POOL_STATUSES = Object.freeze(["vacant", "in_use", "storage", "with_customer"]);

export function normalizeTrayPoolStatus(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return TRAY_POOL_STATUSES.includes(raw) ? raw : "";
}

export function isValidTrayPoolStatus(value) {
  return Boolean(normalizeTrayPoolStatus(value));
}

export function normalizeTrayStatus(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "discarded" || raw === "discard" || raw === "deleted" || raw === "deactivate" || raw === "deactive") {
    return "inactive";
  }
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

export const TRAY_HELD_SQL = "('inactive')";
