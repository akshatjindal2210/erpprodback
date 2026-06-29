import { findForwardedQtyByItemAndPacking, findAllSellableForwardingBoxes, findAllForwardedReservesByItemAndPacking } from "../../models/forwardingNote.model.js";
import {
  enrichForwardingBoxesWithPackingStd,
  inferForwardingPackingStandardQty,
  isForwardingLooseBox,
} from "../box/boxLooseKind.js";

export { enrichForwardingBoxesWithPackingStd, inferForwardingPackingStandardQty, isForwardingLooseBox };

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
  const enriched = enrichForwardingBoxesWithPackingStd(boxes);
  return [...enriched].sort((a, b) => {
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
    const stdQty = inferForwardingPackingStandardQty(packingBoxes);
    const openBoxes = packingBoxes.filter((b) => !isForwardingLooseBox(b, stdQty));
    const looseBoxes = packingBoxes.filter((b) => isForwardingLooseBox(b, stdQty));

    result.push(...applyQtySkipToBoxes(openBoxes, reserve.open_qty));
    result.push(...applyQtySkipToBoxes(looseBoxes, reserve.loose_qty));
  }
  return enrichForwardingBoxesWithPackingStd(result);
}

export async function buildForwardingAvailableBoxes(boxes = [], item_dcode, exclude_fuid = null) {
  const forwarded = await findForwardedQtyByItemAndPacking(item_dcode, exclude_fuid);
  return reduceBoxesByForwardedQty(boxes, forwarded);
}

export function sumBoxQty(boxes = []) {
  return (boxes || []).reduce((s, b) => s + (Number(b.qty) || 0), 0);
}

function buildForwardedMapByItem(rows = []) {
  const byItem = new Map();
  for (const row of rows || []) {
    const itemId = String(row.itemdcode ?? "").trim();
    const pn = String(row.packing_number ?? "").trim();
    if (!itemId || !pn) continue;
    if (!byItem.has(itemId)) byItem.set(itemId, {});
    byItem.get(itemId)[pn] = {
      open_qty: Number(row.open_qty) || 0,
      loose_qty: Number(row.loose_qty) || 0,
      total_qty: Number(row.total_qty) || 0,
    };
  }
  return byItem;
}

/** Item dcodes with FG stock available for a new forwarding note row (after other-note reserves). */
export async function findItemDcodesWithForwardingAvailableStock(exclude_fuid = null) {
  const [allBoxes, forwardRows] = await Promise.all([
    findAllSellableForwardingBoxes(),
    findAllForwardedReservesByItemAndPacking(exclude_fuid),
  ]);

  const boxesByItem = new Map();
  for (const box of allBoxes || []) {
    const itemId = String(box.itemdcode ?? "").trim();
    if (!itemId) continue;
    if (!boxesByItem.has(itemId)) boxesByItem.set(itemId, []);
    boxesByItem.get(itemId).push(box);
  }

  const forwardByItem = buildForwardedMapByItem(forwardRows);
  const available = [];

  for (const [itemId, boxes] of boxesByItem.entries()) {
    const forwarded = forwardByItem.get(itemId) || {};
    const reduced = reduceBoxesByForwardedQty(boxes, forwarded);
    if (sumBoxQty(reduced) > 0) available.push(itemId);
  }

  return available;
}
