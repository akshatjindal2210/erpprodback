/**
 * Forwarding Note — save line items from modal payload.
 *
 * 1. Validate selected box qty vs remaining stock (FIFO minus other FNs)
 * 2. Group scanned boxes by packing number (open vs loose)
 * 3. Insert into ims_forwarding_note_item_wise
 */

import { findAvailableBoxes } from "../../models/forwardingNote.model.js";
import { findBoxesByNoUids } from "../../models/box.model.js";
import { insertForwardingNoteItem } from "../../models/forwardingNoteItem.model.js";
import { docNoFromStandardBoxNoUid } from "../box/boxUid.js";
import { buildForwardingAvailableBoxes, sumBoxQty } from "./forwardingAvailableStock.js";

async function enrichSelectedBoxes(selected_boxes = []) {
  if (!selected_boxes?.length) return [];

  const uids = [...new Set(selected_boxes.map((b) => String(b?.box_no_uid ?? "").trim()).filter(Boolean))];
  const rows = uids.length ? await findBoxesByNoUids(uids) : [];
  const byUid = new Map(rows.map((r) => [String(r.box_no_uid).trim(), r]));

  return selected_boxes.map((box) => {
    const uid = String(box?.box_no_uid ?? "").trim();
    const db = uid ? byUid.get(uid) : null;
    const packing =
      String(box?.packing_number ?? "").trim() ||
      String(db?.packing_number ?? "").trim() ||
      docNoFromStandardBoxNoUid(uid) ||
      "";
    return {
      ...box,
      packing_number: packing,
      is_loose: box.is_loose ?? db?.is_loose ?? false,
      qty: box.qty != null && box.qty !== "" ? box.qty : db?.qty,
    };
  });
}

function groupSelectedBoxesByPacking(selected_boxes = []) {
  return (selected_boxes || []).reduce((acc, box) => {
    const pNo = String(box.packing_number ?? "").trim() || "N/A";
    if (!acc[pNo]) acc[pNo] = { open_boxes: 0, open_qty: 0, loose_boxes: 0, loose_qty: 0 };

    if (box.is_loose) {
      acc[pNo].loose_boxes += 1;
      acc[pNo].loose_qty += Number(box.qty);
    } else {
      acc[pNo].open_boxes += 1;
      acc[pNo].open_qty += Number(box.qty);
    }
    return acc;
  }, {});
}

async function assertSelectionWithinRemaining(item_dcode, selected_boxes = [], exclude_fuid = null) {
  const clean = Number(item_dcode);
  if (!Number.isFinite(clean) || !Array.isArray(selected_boxes) || !selected_boxes.length) return;

  const physical = await findAvailableBoxes(clean);
  const allowed = await buildForwardingAvailableBoxes(physical, clean, exclude_fuid);
  const maxQty = sumBoxQty(allowed);
  const pickQty = sumBoxQty(selected_boxes);

  if (pickQty > maxQty + 0.0001) {
    const err = new Error(`Dispatch qty exceeds remaining stock (max ${maxQty}).`);
    err.statusCode = 400;
    throw err;
  }
}

async function insertOneItemRow(fuid, item, userId) {
  if (item.is_pre_calculated) {
    await insertForwardingNoteItem({
      fuid,
      item_dcode: item.item_dcode,
      packing_number: item.packing_number,
      box: item.box,
      box_qty: item.box_qty,
      loose_box: item.loose_box,
      loose_box_qty: item.loose_box_qty,
      total_qty: item.total_qty,
      created_by: userId,
    });
    return;
  }

  const grouped = groupSelectedBoxesByPacking(item.selected_boxes);
  for (const [packing_number, stats] of Object.entries(grouped)) {
    await insertForwardingNoteItem({
      fuid,
      item_dcode: item.item_dcode,
      packing_number,
      box: stats.open_boxes,
      box_qty: stats.open_qty,
      loose_box: stats.loose_boxes,
      loose_box_qty: stats.loose_qty,
      total_qty: stats.open_qty + stats.loose_qty,
      created_by: userId,
    });
  }
}

/** Insert all items for create or update (after soft-delete on update). */
export async function saveForwardingNoteItems({ fuid, items = [], userId, excludeFuid = null }) {
  for (const item of items) {
    const enrichedItem = {
      ...item,
      selected_boxes: item.selected_boxes?.length
        ? await enrichSelectedBoxes(item.selected_boxes)
        : item.selected_boxes,
    };
    if (!enrichedItem.is_pre_calculated && enrichedItem.selected_boxes?.length) {
      await assertSelectionWithinRemaining(enrichedItem.item_dcode, enrichedItem.selected_boxes, excludeFuid);
    }
    await insertOneItemRow(fuid, enrichedItem, userId);
  }
}
