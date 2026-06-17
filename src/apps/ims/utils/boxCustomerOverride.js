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

/** Stock adjustment minus: customer from selected boxes (override first, else packing prod). */
export function customerCodeFromBoxRow(box) {
  return effectiveBoxCustomerAcc(
    box?.override_cust,
    box?.prod_acc_code ?? box?.acc_code
  );
}

/** Group minus boxes by customer — qty + box count per customer. */
export function groupMinusBoxRowsByCustomer(boxRows) {
  const groups = new Map();
  for (const box of boxRows || []) {
    const code = customerCodeFromBoxRow(box);
    if (!code) continue;
    const qty = Math.abs(parseInt(box?.qty, 10) || 0);
    const pn = String(box?.packing_number ?? "").trim();
    if (!groups.has(code)) {
      groups.set(code, {
        acc_code: code,
        packing_number: pn,
        qty: 0,
        box_count: 0,
      });
    }
    const g = groups.get(code);
    g.qty += qty;
    g.box_count += 1;
    if (!g.packing_number && pn) g.packing_number = pn;
  }
  return [...groups.values()].sort((a, b) =>
    String(a.acc_code).localeCompare(String(b.acc_code))
  );
}

/** DB record: one code, or comma-separated when minus spans multiple customers. */
export function resolveAccCodeFromBoxRows(boxRows) {
  const groups = groupMinusBoxRowsByCustomer(boxRows);
  if (!groups.length) return null;
  return groups.map((g) => g.acc_code).join(",");
}
