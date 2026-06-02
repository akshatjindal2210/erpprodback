import { findForwardedQtyByItemAndPacking } from "../models/forwardingNote.model.js";

/** Same FIFO order as ForwardingModal `sortBoxesForFifo`. */
export function sortBoxesForForwardingFifo(boxes = []) {
  return [...boxes].sort((a, b) => {
    const pA = Number(a?.packing_number ?? 0);
    const pB = Number(b?.packing_number ?? 0);
    if (pA !== pB) return pA - pB;

    const looseA = a?.is_loose ? 1 : 0;
    const looseB = b?.is_loose ? 1 : 0;
    if (looseA !== looseB) return looseA - looseB;

    return Number(a?.box_uid ?? 0) - Number(b?.box_uid ?? 0);
  });
}

/**
 * Skip qty already reserved on other forwarding notes (per packing, FIFO).
 * Physical boxes stay in warehouse until out entry; this only limits the next FN.
 */
export function reduceBoxesByForwardedQty(boxes = [], forwardedByPacking = {}) {
  const skipByPacking = new Map();
  for (const [k, v] of Object.entries(forwardedByPacking || {})) {
    const key = String(k ?? "").trim();
    if (!key) continue;
    skipByPacking.set(key, Math.max(0, Number(v) || 0));
  }

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
    let skip = skipByPacking.get(pNo) || 0;
    for (const box of byPacking.get(pNo) || []) {
      const physical = Number(box.qty) || 0;
      if (physical <= 0) continue;
      if (skip >= physical) {
        skip -= physical;
        continue;
      }
      const remaining = physical - skip;
      skip = 0;
      if (remaining > 0) {
        result.push({ ...box, qty: remaining, physical_qty: physical });
      }
    }
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
