/** Stored on `ims_tray_master.type` (codes FG1, RM12, PRD3). IMS UI picks FG/RM only; PRD is created from Production Bin Master. */
export const TRAY_TYPES = [
  { code: "FG", label: "Finished Good" },
  { code: "RM", label: "Raw Material" },
];

import { BIN_APP_TYPES, BIN_MATERIAL_CODES, BIN_MATERIALS, BIN_PRODUCT } from "./binMaterials.js";

/** Production bin row `type` (FG / RM / PRD + legacy). */
export const BIN_TYPES = [
  ...BIN_APP_TYPES,
  { code: "PROD", label: "Production (legacy)" },
  { code: "BIN", label: "Bin" },
  { code: "TOTE", label: "Tote" },
  ...BIN_MATERIALS,
];

export const TRAY_TYPE_CODES = TRAY_TYPES.map((row) => row.code);
export const BIN_TYPE_CODES = BIN_TYPES.map((row) => row.code);

export const IMS_TRAY_TYPE_SQL = "('FG', 'RM')";
/** Production bins (PRD / PROD) + legacy rows that used material as tray `type`. */
export const BIN_TYPE_SQL = `('PRD', 'PROD', 'PLASTIC', 'IRON', 'BIN', 'TOTE')`;

export function normalizeTrayType(value) {
  return String(value || "").trim().toUpperCase();
}

export function isValidTrayType(value) {
  return TRAY_TYPE_CODES.includes(normalizeTrayType(value));
}

export function isValidBinType(value) {
  const t = normalizeTrayType(value);
  if (BIN_TYPE_CODES.includes(t) || BIN_MATERIAL_CODES.includes(t)) return true;
  return /^[A-Z0-9_]{1,20}$/.test(t);
}

export const normalizeBinType = normalizeTrayType;
