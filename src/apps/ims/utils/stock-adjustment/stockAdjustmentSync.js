import { updateAdjustmentsTx } from "../../models/stockAdjustment.model.js";
import { findBoxesByUids } from "../../models/box.model.js";
import { boxBelongsToPackingNumber, isBoxAvailableForMinus } from "../box/boxInventory.js";
import { resolveAccCodeFromBoxRows } from "../box/boxCustomerOverride.js";
import { buildMinusRemovedBoxIdsJson } from "./minusRemovedBoxPayload.js";
import { getImsMapsSafe } from "../erp-api/imsLookup.js";

/**
 * Pending edit: update adjustment row only — ims_box_table changes on approve.
 */
export async function syncAdjustmentMetadataOnly(client, { existing, body, userId }) {
  if (!existing) return false;
  const entryType = existing.entry_type;
  const fields = {};
  let touched = false;

  if (body.per_box_qty !== undefined) {
    const pb = parseInt(String(body.per_box_qty), 10);
    if (Number.isFinite(pb) && pb >= 1) {
      fields.per_box_qty = pb;
      touched = true;
    }
  }

  if (entryType === "add") {
    if (body.category_id !== undefined) {
      const catId = parseInt(String(body.category_id), 10);
      if (Number.isFinite(catId) && catId > 0) {
        fields.category_id = catId;
        touched = true;
      }
    }

    const toRemove = Array.isArray(body.remove_add_box_uids) ? body.remove_add_box_uids : [];
    const extra = parseInt(String(body.add_extra_boxes ?? 0), 10) || 0;
    const hasPlan =
      body.remove_add_box_uids !== undefined ||
      body.add_extra_boxes !== undefined ||
      body.box_count_impact !== undefined ||
      body.no_of_boxes !== undefined;

    if (hasPlan) {
      let finalCount = parseInt(String(body.box_count_impact ?? body.no_of_boxes ?? ""), 10);
      if (!Number.isFinite(finalCount) || finalCount < 1) {
        const base = parseInt(String(existing.box_count_impact ?? ""), 10) || 0;
        const removeN = [...new Set(toRemove.map((u) => Number(u)).filter((n) => Number.isFinite(n)))].length;
        finalCount = Math.max(1, base - removeN + extra);
      }
      fields.box_count_impact = finalCount;
      const pb = fields.per_box_qty ?? parseInt(String(existing.per_box_qty ?? ""), 10);
      if (Number.isFinite(pb) && pb >= 1) {
        fields.qty = finalCount * pb;
      }
      if (toRemove.length) {
        fields.removed_box_ids = JSON.stringify(
          toRemove.map((u) => Number(u)).filter((n) => Number.isFinite(n))
        );
      }
      touched = true;
    }
  }

  if (entryType === "minus" && body.removed_box_uids !== undefined) {
    const uids = [...new Set((Array.isArray(body.removed_box_uids) ? body.removed_box_uids : []).map((u) => Number(u)).filter((n) => Number.isFinite(n)))];
    if (!uids.length) {
      const err = new Error("Select at least one box.");
      err.statusCode = 400;
      throw err;
    }
    const pn = String(existing.packing_number ?? "").trim();
    const rows = await findBoxesByUids(uids.map(String));
    const live = (rows || []).filter(
      (r) => !r.is_deleted && boxBelongsToPackingNumber(r, pn)
    );
    if (live.length !== uids.length) {
      const err = new Error("Some boxes do not match this packing number or are deleted.");
      err.statusCode = 400;
      throw err;
    }
    const blocked = live.find(
      (r) => !isBoxAvailableForMinus(r, { adjustmentId: existing.adjustment_id })
    );
    if (blocked) {
      const err = new Error(
        "Some boxes are not in hand — dispatched or already removed via another adjustment."
      );
      err.statusCode = 400;
      throw err;
    }
    const sumQty = live.reduce((s, r) => s + (parseInt(r.qty, 10) || 0), 0);
    fields.acc_code = resolveAccCodeFromBoxRows(live);
    const { ledgerMap } = await getImsMapsSafe();
    fields.removed_box_ids = buildMinusRemovedBoxIdsJson(live, pn, ledgerMap);
    fields.box_count_impact = uids.length;
    fields.qty = -Math.abs(sumQty);
    touched = true;
  }

  if (!touched) return false;

  fields.updated_by = userId;
  fields.updated_at = new Date();
  await updateAdjustmentsTx(client, fields, { adjustment_id: existing.adjustment_id });
  return true;
}

/** @deprecated use syncAdjustmentMetadataOnly */
export async function syncPendingPackingAdjustment(client, opts) {
  return syncAdjustmentMetadataOnly(client, opts);
}
