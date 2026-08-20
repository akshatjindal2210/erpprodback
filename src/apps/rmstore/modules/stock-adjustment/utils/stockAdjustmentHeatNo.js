/** Normalize heat / lot number for Stock Adjustment header persistence. */
export function normalizeHeatNo(value) {
  const s = value != null ? String(value).trim() : "";
  return s || null;
}

/** Prefer explicit body value, then coil MRN heat/lot, then MRN row. */
export function resolveEffectiveHeatNo({ bodyHeatNo, coils = [], mrnRow = null } = {}) {
  const fromBody = normalizeHeatNo(bodyHeatNo);
  if (fromBody) return fromBody;

  for (const coil of coils) {
    const h = normalizeHeatNo(coil?.heat_no) || normalizeHeatNo(coil?.it_lot_no);
    if (h) return h;
  }

  return normalizeHeatNo(mrnRow?.heat_no) || normalizeHeatNo(mrnRow?.it_lot_no) || null;
}
