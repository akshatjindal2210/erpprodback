/**
 * Single source of truth — full/open vs loose box classification.
 * Keep in sync with `frontend/src/core/utils/utilHelper.js` (isForwardingLooseBox*).
 */

export function inferPackingStandardQtyFromBoxes(boxes = []) {
  const counts = new Map();
  for (const box of boxes || []) {
    const flaggedLoose =
      box?.is_loose === true || box?.is_loose === 1 || box?.is_loose === "true" || box?.is_loose === "t";
    if (flaggedLoose) continue;
    const qty = Math.round(Number(box?.qty) || 0);
    if (qty > 0) counts.set(qty, (counts.get(qty) || 0) + 1);
  }
  if (counts.size === 0) {
    for (const box of boxes || []) {
      const qty = Math.round(Number(box?.qty) || 0);
      if (qty > 0) counts.set(qty, (counts.get(qty) || 0) + 1);
    }
  }
  let bestQty = 0;
  let bestCount = 0;
  for (const [qty, count] of counts) {
    if (count > bestCount || (count === bestCount && qty > bestQty)) {
      bestQty = qty;
      bestCount = count;
    }
  }
  return bestQty > 0 ? bestQty : 0;
}

/** Same as inferPackingStandardQtyFromBoxes but returns null when unknown (stock adjustment). */
export function inferStandardQtyFromBoxQtys(boxes = []) {
  const qty = inferPackingStandardQtyFromBoxes(boxes);
  return qty > 0 ? qty : null;
}

/** Alias used by forwarding. */
export const inferForwardingPackingStandardQty = inferPackingStandardQtyFromBoxes;

export function isBoxLooseComparedToStandard(perBoxQty, standardQtyPerBox) {
  const p = parseInt(String(perBoxQty ?? ""), 10);
  const s = parseInt(String(standardQtyPerBox ?? ""), 10);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(s) || s <= 0) return false;
  return p !== s;
}

/** @deprecated use isBoxLooseComparedToStandard */
export const isLooseBoxComparedToStandard = isBoxLooseComparedToStandard;

export function isBoxLoose(box, packingStandardQty = null) {
  const v = box?.is_loose;
  if (v === true || v === 1 || v === "true" || v === "t") return true;

  const qty = Math.round(Number(box?.qty) || 0);
  const std = Math.round(
    Number(
      packingStandardQty != null
        ? packingStandardQty
        : box?._packing_std_qty ?? box?.standard_qty_per_box ?? 0
    ) || 0
  );
  if (std > 0 && qty > 0 && qty !== std) return true;
  return false;
}

/** @deprecated use isBoxLoose — kept for forwarding imports */
export const isForwardingLooseBox = isBoxLoose;

export function enrichBoxesWithPackingStdQty(boxes = []) {
  const byPacking = new Map();
  for (const box of boxes || []) {
    const pn = String(box?.packing_number ?? "").trim() || "N/A";
    if (!byPacking.has(pn)) byPacking.set(pn, []);
    byPacking.get(pn).push(box);
  }
  const stdByPacking = new Map();
  for (const [pn, list] of byPacking) {
    stdByPacking.set(pn, inferPackingStandardQtyFromBoxes(list));
  }
  return (boxes || []).map((box) => {
    const pn = String(box?.packing_number ?? "").trim() || "N/A";
    return { ...box, _packing_std_qty: stdByPacking.get(pn) || null };
  });
}

export const enrichForwardingBoxesWithPackingStd = enrichBoxesWithPackingStdQty;
