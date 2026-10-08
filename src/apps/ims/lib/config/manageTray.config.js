export const MANAGE_TRAY_ENFORCE_FROM = "2026-10-01";

/**
 * Packing categories for Manage Tray (+ Store In gate until registered).
 * Current: OEM Tray only. Future: add "tray" → `["tray", "oem tray"]`.
 */
export const MANAGE_TRAY_CATEGORY_NAMES = ["oem tray"];

/** SQL IN list from MANAGE_TRAY_CATEGORY_NAMES, e.g. `'oem tray'` or `'tray', 'oem tray'`. */
export function sqlManageTrayCategoryInList() {
  return MANAGE_TRAY_CATEGORY_NAMES.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(", ");
}
