import { normalizeTrayType } from "./trayTypes.js";

/** Tray/bin QR codes — `ims_tray_master.type` prefixes only (not b_type Plastic/Iron). */
export const TRAY_MASTER_CODE_TYPES = ["FG", "RM", "PRD", "PROD"];

/** Legacy `FG1` / `PRD5` or segmented `FG_A_001` / `PRD_A_1`. */
export const TRAY_CODE_RE = /^(?:FG|RM|PRD|PROD)(?:\d+|_[A-Z0-9]{1,10}_\d+)$/i;

/** Code letter between tray type and serial (e.g. A in PRD_A_1) — `ims_tray_master.letter`. */
export function normalizeTrayLetter(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return null;
  if (!/^[A-Z0-9]{1,10}$/.test(raw)) return null;
  return raw;
}

export const normalizeTrayCategory = normalizeTrayLetter;

export function isValidTrayLetter(value) {
  return normalizeTrayLetter(value) != null;
}

export const isValidTrayCategory = isValidTrayLetter;

/** FG/RM use zero-padded serial in segmented codes; PRD uses plain serial. */
export function formatTraySerialPart(type, serialNumber) {
  const t = normalizeTrayType(type);
  const serial = Math.trunc(Number(serialNumber));
  if (!Number.isFinite(serial) || serial < 0) return "";
  if (t === "PRD" || t === "PROD") return String(serial);
  return String(serial).padStart(3, "0");
}

export function buildTrayCode(type, letter, serialNumber) {
  const t = normalizeTrayType(type);
  const cat = normalizeTrayLetter(letter);
  const serialPart = formatTraySerialPart(t, serialNumber);
  if (!serialPart) return "";
  if (!cat) return `${t}${serialPart}`;
  return `${t}_${cat}_${serialPart}`;
}

/** Normalize scanned tray code for DB lookup (pad FG/RM legacy; keep PRD serial as-is). */
export function normalizeTrayLookupCode(code) {
  const c = String(code ?? "").trim().toUpperCase();
  if (!c) return c;

  const segmented = /^(FG|RM|PRD|PROD)_([A-Z0-9]{1,10})_(\d+)$/.exec(c);
  if (segmented) {
    const type = segmented[1];
    const cat = segmented[2];
    const serial = parseInt(segmented[3], 10);
    if (!Number.isFinite(serial)) return c;
    if (type === "FG" || type === "RM") {
      return `${type}_${cat}_${String(serial).padStart(3, "0")}`;
    }
    return `${type}_${cat}_${serial}`;
  }

  const legacy = /^(FG|RM|PRD|PROD)(\d+)$/.exec(c);
  if (!legacy) return c;
  const type = legacy[1];
  const n = parseInt(legacy[2], 10);
  if (!Number.isFinite(n)) return c;
  if (type === "FG" || type === "RM") return `${type}${String(n).padStart(3, "0")}`;
  return `${type}${n}`;
}

export function batchIdFromCodes(startCode, endCode) {
  const start = String(startCode || "").trim();
  const end = String(endCode || "").trim();
  if (!start || !end) return "";
  if (start === end) return start;
  return `${start}-${end}`;
}
