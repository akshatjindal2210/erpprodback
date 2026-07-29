/**
 * Forwarding Note — save line items from modal payload.
 *
 * 1. Validate selected box qty vs remaining stock (FIFO minus other FNs), per packing
 * 2. Group scanned boxes by packing number (open vs loose)
 * 3. Insert into ims_forwarding_note_item_wise (inside transaction + advisory lock)
 */

import { withTransaction } from "../../../../../../config/db/db.js";
import { findAvailableBoxes } from "../../models/forwardingNote.model.js";
import { findBoxesByNoUids } from "../../../box/models/box.model.js";
import { deleteForwardingNoteItems, findActiveForwardingNoteItemsByFuid, insertForwardingNoteItem } from "../../models/forwardingNoteItem.model.js";
import { docNoFromStandardBoxNoUid } from "../../../box/utils/uid/boxUid.js";
import { buildForwardingAvailableBoxes, enrichForwardingBoxesWithPackingStd, inferForwardingPackingStandardQty, isForwardingLooseBox, sumBoxQty } from "../stock/forwardingAvailableStock.js";
import { loadScheduleDispatchQtyMap, loadScheduleQtyForKeys, planKey } from "../../../schedule-planning/utils/db/schedulePlanDb.js";

const FN_RESERVE_LOCK_NS = 71;

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
  const byPacking = {};
  for (const box of selected_boxes || []) {
    const pNo = String(box.packing_number ?? "").trim() || "N/A";
    if (!byPacking[pNo]) byPacking[pNo] = [];
    byPacking[pNo].push(box);
  }

  return Object.entries(byPacking).reduce((acc, [pNo, boxes]) => {
    const enriched = enrichForwardingBoxesWithPackingStd(boxes);
    const stdQty = inferForwardingPackingStandardQty(enriched);
    acc[pNo] = { open_boxes: 0, open_qty: 0, loose_boxes: 0, loose_qty: 0, total_qty: 0 };

    for (const box of enriched) {
      if (isForwardingLooseBox(box, stdQty)) {
        acc[pNo].loose_boxes += 1;
        acc[pNo].loose_qty += Number(box.qty) || 0;
      } else {
        acc[pNo].open_boxes += 1;
        acc[pNo].open_qty += Number(box.qty) || 0;
      }
    }
    acc[pNo].total_qty = acc[pNo].open_qty + acc[pNo].loose_qty;
    return acc;
  }, {});
}

function extractItemDispatchTotalQty(item) {
  const demandByPacking = buildDemandByPacking(item);
  return Object.values(demandByPacking).reduce((sum, stats) => sum + (Number(stats?.total_qty) || 0), 0);
}

function buildScheduleDemandByKey(items = []) {
  const byKey = new Map();
  for (const item of items || []) {
    const schno = item?.schno != null ? String(item.schno).trim() : "";
    const itemdcode = Number(item?.item_dcode);
    if (!schno || !Number.isFinite(itemdcode)) continue;

    const qty = extractItemDispatchTotalQty(item);
    if (!(qty > 0)) continue;

    const key = planKey(schno, itemdcode);
    byKey.set(key, (byKey.get(key) || 0) + qty);
  }
  return byKey;
}

/**
 * Schedule-linked FN lines cannot exceed remaining balance (schedule qty − other FNs).
 * Physical stock reserve alone is not enough — duplicate FNs were possible when FG stock > balance.
 */
export async function assertScheduleDispatchWithinBalance(items = [], exclude_fuid = null) {
  const demandByKey = buildScheduleDemandByKey(items);
  if (!demandByKey.size) return;

  const pairs = [...demandByKey.keys()].map((key) => {
    const [schno, itemdcode] = key.split("|");
    return { schno, itemdcode: Number(itemdcode) };
  });

  const [scheduleQtyMap, dispatchMap] = await Promise.all([
    loadScheduleQtyForKeys(pairs),
    loadScheduleDispatchQtyMap({ excludeFuid: exclude_fuid }),
  ]);

  for (const [key, demandQty] of demandByKey.entries()) {
    const scheduleQty = Number(scheduleQtyMap.get(key) ?? 0);
    if (!(scheduleQty > 0)) {
      const [schno, itemdcode] = key.split("|");
      throw reserveValidationError(
        `Schedule Sch ${schno} item ${itemdcode} is not on the current schedule plan.`
      );
    }

    const alreadyDispatched = Number(dispatchMap.get(key) ?? 0);
    const remaining = Math.max(0, scheduleQty - alreadyDispatched);

    if (demandQty > remaining + 0.0001) {
      const [schno, itemdcode] = key.split("|");
      throw reserveValidationError(
        `Schedule Sch ${schno} item ${itemdcode}: dispatch qty ${demandQty} exceeds remaining balance ${remaining} (${alreadyDispatched} already on other forwarding notes).`
      );
    }
  }
}

function buildDemandByPacking(item) {
  if (item.is_pre_calculated) {
    const pNo = String(item.packing_number ?? "").trim();
    if (!pNo) return {};
    return {
      [pNo]: {
        open_qty: Number(item.box_qty) || 0,
        loose_qty: Number(item.loose_box_qty) || 0,
        total_qty: Number(item.total_qty) || 0,
      },
    };
  }

  if (!item.selected_boxes?.length) return {};
  return groupSelectedBoxesByPacking(item.selected_boxes);
}

function reserveValidationError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * One item_dcode per Forwarding Note *modal row* (selected_boxes payloads).
 * Packing breakdown rows (is_pre_calculated) may repeat the same item_dcode — that is OK.
 * Blocks API bypass of the UI unique-item rule (same item from two schedules).
 */
export function assertUniqueForwardingItemDcodes(items = []) {
  const seen = new Set();
  for (const item of items || []) {
    // Saved packing splits of one item — not duplicate schedule lines.
    if (item?.is_pre_calculated) continue;
    const raw = item?.item_dcode;
    if (raw == null || String(raw).trim() === "") continue;
    const key = String(raw).trim();
    if (seen.has(key)) {
      throw reserveValidationError(
        "Same item cannot appear twice on one Forwarding Note. Use a separate note for another schedule of this item."
      );
    }
    seen.add(key);
  }
}

/**
 * Same physical box must not be claimed by two payload item rows (FIFO integrity).
 */
export function assertNoDuplicateSelectedBoxes(items = []) {
  const seen = new Set();
  for (const item of items || []) {
    for (const box of item?.selected_boxes || []) {
      const key = String(box?.box_no_uid ?? box?.box_uid ?? "").trim();
      if (!key) continue;
      if (seen.has(key)) {
        throw reserveValidationError(
          `Box ${key} is selected on more than one item. FIFO selection cannot overlap.`
        );
      }
      seen.add(key);
    }
  }
}

/**
 * Validate dispatch qty against physical stock minus all saved FN rows (pending + approved).
 * UI availability and save both use the same reserve scope — qty reserved as soon as the note is saved.
 */
export async function assertForwardingItemsWithinRemaining(
  items = [],
  exclude_fuid = null,
  { client, approvedOnly = false } = {}
) {
  const byItem = new Map();

  for (const item of items || []) {
    const dcode = Number(item.item_dcode);
    if (!Number.isFinite(dcode)) continue;

    const demandByPacking = buildDemandByPacking(item);
    if (!Object.keys(demandByPacking).length) continue;

    if (!byItem.has(dcode)) byItem.set(dcode, {});
    const merged = byItem.get(dcode);

    for (const [packing, stats] of Object.entries(demandByPacking)) {
      if (!merged[packing]) {
        merged[packing] = { open_qty: 0, loose_qty: 0, total_qty: 0 };
      }
      merged[packing].open_qty += stats.open_qty;
      merged[packing].loose_qty += stats.loose_qty;
      merged[packing].total_qty += stats.total_qty;
    }
  }

  for (const [item_dcode, demandByPacking] of byItem.entries()) {
    const physical = await findAvailableBoxes(item_dcode, { client });
    const allowed = await buildForwardingAvailableBoxes(physical, item_dcode, exclude_fuid, {
      approvedOnly,
      client,
    });
    const allowedByPacking = groupSelectedBoxesByPacking(allowed);

    let pickTotal = 0;
    let maxTotal = sumBoxQty(allowed);

    for (const [packing, demand] of Object.entries(demandByPacking)) {
      const allowedPacking = allowedByPacking[packing] || { open_qty: 0, loose_qty: 0, total_qty: 0 };
      pickTotal += demand.total_qty;

      if (demand.open_qty > allowedPacking.open_qty + 0.0001) {
        throw reserveValidationError(
          `Packing ${packing}: open qty ${demand.open_qty} exceeds available ${allowedPacking.open_qty} (already reserved on another forwarding note).`
        );
      }
      if (demand.loose_qty > allowedPacking.loose_qty + 0.0001) {
        throw reserveValidationError(
          `Packing ${packing}: loose qty ${demand.loose_qty} exceeds available ${allowedPacking.loose_qty} (already reserved on another forwarding note).`
        );
      }
    }

    if (pickTotal > maxTotal + 0.0001) {
      throw reserveValidationError(
        `Dispatch qty ${pickTotal} exceeds remaining stock (max ${maxTotal}) for item ${item_dcode}.`
      );
    }
  }
}

async function lockItemDcodes(client, itemDcodes = []) {
  const sorted = [...new Set(itemDcodes.map((d) => Number(d)).filter(Number.isFinite))].sort((a, b) => a - b);
  for (const dcode of sorted) {
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [FN_RESERVE_LOCK_NS, dcode]);
  }
}

async function enrichItems(items = []) {
  const out = [];
  for (const item of items || []) {
    out.push({
      ...item,
      selected_boxes: item.selected_boxes?.length
        ? await enrichSelectedBoxes(item.selected_boxes)
        : item.selected_boxes,
    });
  }
  return out;
}

async function insertOneItemRow(fuid, item, userName, client) {
  const itemSchno =
    item.schno != null && String(item.schno).trim() !== "" ? String(item.schno).trim() : null;

  if (item.is_pre_calculated) {
    await insertForwardingNoteItem(
      {
        fuid,
        item_dcode: item.item_dcode,
        packing_number: item.packing_number,
        box: item.box,
        box_qty: item.box_qty,
        loose_box: item.loose_box,
        loose_box_qty: item.loose_box_qty,
        total_qty: item.total_qty,
        schno: itemSchno,
        created_by: userName,
      },
      { client }
    );
    return;
  }

  const grouped = groupSelectedBoxesByPacking(item.selected_boxes);
  for (const [packing_number, stats] of Object.entries(grouped)) {
    await insertForwardingNoteItem(
      {
        fuid,
        item_dcode: item.item_dcode,
        packing_number,
        box: stats.open_boxes,
        box_qty: stats.open_qty,
        loose_box: stats.loose_boxes,
        loose_box_qty: stats.loose_qty,
        total_qty: stats.open_qty + stats.loose_qty,
        schno: itemSchno,
        created_by: userName,
      },
      { client }
    );
  }
}

/** Re-validate saved rows before approve (no item payload in request). */
export async function validateExistingForwardingNoteItems({ fuid, excludeFuid = null, client } = {}) {
  if (!client) {
    return withTransaction(async (txnClient) =>
      validateExistingForwardingNoteItems({ fuid, excludeFuid, client: txnClient })
    );
  }

  const rows = await findActiveForwardingNoteItemsByFuid(fuid, { client });
  const items = (rows || []).map((row) => ({
    item_dcode: row.item_dcode,
    schno: row.schno != null && String(row.schno).trim() !== "" ? String(row.schno).trim() : null,
    packing_number: row.packing_number,
    box: row.box,
    box_qty: row.box_qty,
    loose_box: row.loose_box,
    loose_box_qty: row.loose_box_qty,
    total_qty: row.total_qty,
    is_pre_calculated: true,
  }));

  await lockItemDcodes(client, items.map((i) => i.item_dcode));
  await assertScheduleDispatchWithinBalance(items, excludeFuid ?? fuid);
  await assertForwardingItemsWithinRemaining(items, excludeFuid ?? fuid, { client, approvedOnly: false });
}

async function persistForwardingNoteItems({ fuid, items, userName, excludeFuid, replaceExisting, client }) {
  assertUniqueForwardingItemDcodes(items);
  assertNoDuplicateSelectedBoxes(items);

  const enrichedItems = await enrichItems(items);
  const itemDcodes = enrichedItems.map((i) => i.item_dcode);

  await lockItemDcodes(client, itemDcodes);
  await assertScheduleDispatchWithinBalance(enrichedItems, excludeFuid);
  await assertForwardingItemsWithinRemaining(enrichedItems, excludeFuid, { client, approvedOnly: false });

  if (replaceExisting) {
    await deleteForwardingNoteItems({ fuid }, { deleted_by: userName }, { client });
  }

  for (const item of enrichedItems) {
    await insertOneItemRow(fuid, item, userName, client);
  }
}

/** Insert all items for create (after master insert). */
export async function saveForwardingNoteItems({ fuid, items = [], userName, excludeFuid = null }) {
  if (!items.length) return;

  await withTransaction(async (client) => {
    await persistForwardingNoteItems({
      fuid,
      items,
      userName,
      excludeFuid,
      replaceExisting: false,
      client,
    });
  });
}

/** Replace all items on update — delete + insert in one transaction. */
export async function replaceForwardingNoteItems({ fuid, items = [], userName, excludeFuid = null }) {
  if (!items.length) return;

  await withTransaction(async (client) => {
    await persistForwardingNoteItems({
      fuid,
      items,
      userName,
      excludeFuid,
      replaceExisting: true,
      client,
    });
  });
}
