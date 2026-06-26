import { findForwardedQtyByItemAndPacking } from "../../models/forwardingNote.model.js";

/** Full/open vs loose — read `ims_box_table.is_loose` (set at sticker / adjustment create). */
export function isForwardingLooseBox(box) {
  const v = box?.is_loose;
  return v === true || v === 1 || v === "true" || v === "t";
}

function normalizeForwardedReserveEntry(v) {
  if (v == null || v === "") return { open_qty: 0, loose_qty: 0, total_qty: 0 };
  if (typeof v === "number") {
    const t = Math.max(0, v);
    return { open_qty: t, loose_qty: 0, total_qty: t };
  }
  const open_qty = Math.max(0, Number(v.open_qty) || 0);
  const loose_qty = Math.max(0, Number(v.loose_qty) || 0);
  const total_qty = Math.max(0, Number(v.total_qty) || open_qty + loose_qty);
  return { open_qty, loose_qty, total_qty };
}

function lookupForwardedReserve(forwardedByPacking, packingNumber) {
  const pn = String(packingNumber ?? "").trim();
  if (!pn) return normalizeForwardedReserveEntry(null);
  return normalizeForwardedReserveEntry(
    forwardedByPacking[pn] ?? forwardedByPacking[String(Number(pn))]
  );
}

/** Total reserved qty for one packing (QC hold / reports). */
export function forwardedTotalQtyForPacking(forwardedByPacking = {}, packingNumber) {
  return lookupForwardedReserve(forwardedByPacking, packingNumber).total_qty;
}

/** Same FIFO order as ForwardingModal `sortBoxesForFifo`. */
export function sortBoxesForForwardingFifo(boxes = []) {
  return [...boxes].sort((a, b) => {
    const pA = Number(a?.packing_number ?? 0);
    const pB = Number(b?.packing_number ?? 0);
    if (pA !== pB) return pA - pB;

    const looseA = isForwardingLooseBox(a) ? 1 : 0;
    const looseB = isForwardingLooseBox(b) ? 1 : 0;
    if (looseA !== looseB) return looseA - looseB;

    return Number(a?.box_uid ?? 0) - Number(b?.box_uid ?? 0);
  });
}

function applyQtySkipToBoxes(boxList, skipQty) {
  let skip = Math.max(0, Number(skipQty) || 0);
  const out = [];
  for (const box of boxList) {
    const physical = Number(box.qty) || 0;
    if (physical <= 0) continue;
    if (skip >= physical) {
      skip -= physical;
      continue;
    }
    const remaining = physical - skip;
    skip = 0;
    if (remaining > 0) {
      out.push({ ...box, qty: remaining, physical_qty: physical });
    }
  }
  return out;
}

/**
 * Skip qty reserved on other forwarding notes (per packing).
 * Open reserve skips full boxes only; loose reserve skips loose boxes only —
 * avoids phantom partials (e.g. 300) on a full box when another FN reserved loose qty.
 */
export function reduceBoxesByForwardedQty(boxes = [], forwardedByPacking = {}) {
  const sorted = sortBoxesForForwardingFifo(boxes);
  const packingOrder = [];
  const byPacking = new Map();

  for (const box of sorted) {
    const pNo = String(box?.packing_number ?? "").trim() || "N/A";
    if (!byPacking.has(pNo)) {
      byPacking.set(pNo, []);
      packingOrder.push(pNo);
    }
    byPacking.get(pNo).push(box);
  }

  const result = [];
  for (const pNo of packingOrder) {
    const reserve = lookupForwardedReserve(forwardedByPacking, pNo);
    const packingBoxes = byPacking.get(pNo) || [];
    const openBoxes = packingBoxes.filter((b) => !isForwardingLooseBox(b));
    const looseBoxes = packingBoxes.filter((b) => isForwardingLooseBox(b));

    result.push(...applyQtySkipToBoxes(openBoxes, reserve.open_qty));
    result.push(...applyQtySkipToBoxes(looseBoxes, reserve.loose_qty));
  }
  return result;
}

export async function buildForwardingAvailableBoxes(boxes = [], item_dcode, exclude_fuid = null) {
  const forwarded = await findForwardedQtyByItemAndPacking(item_dcode, exclude_fuid);
  return reduceBoxesByForwardedQty(boxes, forwarded);
}

export function sumBoxQty(boxes = []) {
  return (boxes || []).reduce((s, b) => s + (Number(b.qty) || 0), 0);
}
