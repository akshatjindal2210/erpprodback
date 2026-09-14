export const TRAY_TYPES = [
  { code: "FG", label: "Finished Good" },
  { code: "RM", label: "Raw Material" },
];

export const TRAY_TYPE_CODES = TRAY_TYPES.map((row) => row.code);

export function normalizeTrayType(value) {
  return String(value || "").trim().toUpperCase();
}

export function isValidTrayType(value) {
  return TRAY_TYPE_CODES.includes(normalizeTrayType(value));
}
