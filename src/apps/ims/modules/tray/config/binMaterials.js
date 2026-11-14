/** Production bin app types (batch / tray `type` — codes like PRD1, FG12). */
export const BIN_PRODUCT = { code: "PRD", label: "Production" };

export const BIN_APP_TYPES = [
  { code: "FG", label: "Finished Good" },
  { code: "RM", label: "Raw Material" },
  { code: "PRD", label: "Production" },
];

export const BIN_APP_TYPE_CODES = BIN_APP_TYPES.map((row) => row.code);

/** `ims_tray_batch.b_type` defaults (Plastic / Iron under tray type PRD). */
export const BIN_MATERIALS = [
  { code: "PLASTIC", label: "Plastic" },
  { code: "IRON", label: "Iron" },
];

export const BIN_MATERIAL_CODES = BIN_MATERIALS.map((row) => row.code);

/** Default code segments for new bin batches (e.g. PRD_A_1). */
export const BIN_CODE_CATEGORIES = ["A", "B"];

export function normalizeBinAppType(value) {
  return String(value || "").trim().toUpperCase();
}

export const normalizeBinMaterial = normalizeBinAppType;

export function toBinAppTag(value) {
  return normalizeBinAppType(value).replace(/[^A-Z0-9_]/g, "");
}

export function isKnownBinAppType(value) {
  return BIN_APP_TYPE_CODES.includes(normalizeBinAppType(value));
}

export function isValidBinMaterial(value) {
  return BIN_MATERIAL_CODES.includes(normalizeBinAppType(value));
}

export function binAppTypeLabel(code) {
  const key = normalizeBinAppType(code);
  const hit = BIN_APP_TYPES.find((row) => row.code === key);
  if (hit) return hit.label;
  const legacy = BIN_MATERIALS.find((row) => row.code === key);
  if (legacy) return legacy.label;
  if (key === "PROD") return "Production (legacy)";
  return code || "—";
}

export function binMaterialLabel(code) {
  const key = normalizeBinAppType(code);
  const mat = BIN_MATERIALS.find((row) => row.code === key);
  if (mat) return mat.label;
  if (key === BIN_PRODUCT.code) return BIN_PRODUCT.label;
  if (key === "PROD") return "Production (legacy)";
  return code || "—";
}
