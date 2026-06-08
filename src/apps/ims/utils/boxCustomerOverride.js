/** Normalize ledger / customer acc codes from DB or IMS. */
export function normalizeAccCode(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  return s === "" || s === "-" ? null : s;
}

/** Customer on sticker: explicit per-box override, else packing / production customer. */
export function effectiveBoxCustomerAcc(overrideCust, packingAccCode) {
  const override = normalizeAccCode(overrideCust);
  const packing = normalizeAccCode(packingAccCode);
  if (!override) return packing;
  if (packing && override === packing) return packing;
  return override;
}

/** True only when this box was changed via customer override (not default sticker customer). */
export function isBoxCustomerOverridden(overrideCust, packingAccCode) {
  const override = normalizeAccCode(overrideCust);
  const packing = normalizeAccCode(packingAccCode);
  return !!override && override !== packing;
}
