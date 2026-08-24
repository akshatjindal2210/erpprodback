import { findBoxesByUids, insertBulkBoxesTx, markBoxesStockAdjustmentOutTx, clearStockAdjustmentMinusMarksTx, findStockAdjustmentAddBoxesTx, permanentlyDeleteStockAdjustmentAddBoxesTx, updateBoxQtyForStockAdjustmentTx } from "../../../box/models/box.model.js";
import { updateAdjustmentsTx } from "../../models/stockAdjustment.model.js";
import { getBoxNoUidPrefix } from "../../../../../core/configuration/models/appConfig.model.js";
import { buildStockAdjustmentAddBoxInsertRows, resolveOverrideCustForPacking } from "../packing/stockAdjustmentPacking.js";
import { persistAdjustmentDocDtTx } from "../doc/stockAdjustmentDocDt.js";
import { boxBelongsToPackingNumber, isBoxAvailableForMinus, isBoxInHand } from "../../../box/utils/inventory/boxInventory.js";
import { resolveAccCodeFromBoxRows } from "../../../box/utils/override-customer/boxCustomerOverride.js";
import { buildMinusRemovedBoxIdsJson, parseRemovedBoxIdsJson } from "../minus/minusRemovedBoxPayload.js";
import { getImsMapsSafe } from "../../../../lib/utils/erp-api/lookup/imsLookup.js";
import { parseQtyUpdatePayload, buildQtyUpdatePayload, computeQtyUpdateResult } from "../update/stockAdjustmentUpdatePayload.js";

export { parseMinusRemovedBoxPayload, parseRemovedBoxIdsJson } from "../minus/minusRemovedBoxPayload.js";
export { parseQtyUpdatePayload } from "../update/stockAdjustmentUpdatePayload.js";

/** Undo minus marks when un-approving or before re-apply. */
export async function revertMinusAdjustmentBoxesTx(client, { adjustment, userId, userName = null }) {
  const adjId = adjustment.adjustment_id;
  const uids = parseRemovedBoxIdsJson(adjustment.removed_box_ids);
  const existing = await findBoxesBySaMinus(client, adjId);
  const allUids = [
    ...new Set([
      ...uids,
      ...existing.map((b) => Number(b.box_uid)).filter((n) => Number.isFinite(n))
    ])
  ];
  if (allUids.length) {
    return await clearStockAdjustmentMinusMarksTx(client, {
      adjustmentId: adjId,
      boxUids: allUids,
      userId,
      userName,
    });
  }
  return [];
}

async function findBoxesBySaMinus(client, adjustmentId) {
  const { rows } = await client.query(
    `SELECT box_uid FROM ims_box_table
     WHERE sa_id = $1::integer AND sa_entry_type = 'stock_out' AND is_deleted = false`,
    [adjustmentId]
  );
  return rows;
}

export async function revertAddAdjustmentBoxesTx(client, { adjustmentId, userId }) {
  return await permanentlyDeleteStockAdjustmentAddBoxesTx(client, { adjustmentId, userId, skipLog: false });
}

/** Apply box changes when adjustment becomes approved (inventory reflects here). */
export async function applyStockAdjustmentOnApproveTx(client, { adjustment, userId, userName = null, allBoxesLoose = false }) {
  const adjId = adjustment.adjustment_id;
  const entryType = adjustment.entry_type;

  if (entryType === "add") {
    await permanentlyDeleteStockAdjustmentAddBoxesTx(client, { adjustmentId: adjId, skipLog: true });

    const packingNumber = String(adjustment.packing_number ?? "").trim();
    const nb = parseInt(String(adjustment.box_count_impact ?? ""), 10);
    const pb = parseInt(String(adjustment.per_box_qty ?? ""), 10);
    if (!packingNumber || !Number.isFinite(nb) || nb < 1 || !Number.isFinite(pb) || pb < 1) {
      const err = new Error("Add adjustment missing packing or box counts.");
      err.statusCode = 400;
      throw err;
    }

    const boxNoUidPrefix = await getBoxNoUidPrefix();
    const override_cust = adjustment.acc_code || (await resolveOverrideCustForPacking(packingNumber, {
      financialYear: adjustment.financial_year,
    }));
    const boxRows = buildStockAdjustmentAddBoxInsertRows({
      packingNumber,
      adjustmentId: adjId,
      totalBoxes: nb,
      perBoxQty: pb,
      isLoose: !!allBoxesLoose,
      userId,
      userName,
      boxNoUidPrefix,
      override_cust,
      category_id: adjustment.category_id ?? null,
    });
    await insertBulkBoxesTx(client, boxRows);

    const qty = nb * pb;
    await updateAdjustmentsTx(
      client,
      {
        box_count_impact: nb,
        per_box_qty: pb,
        qty,
        unit: adjustment.unit ?? "PCS",
      },
      { adjustment_id: adjId }
    );
    await persistAdjustmentDocDtTx(client, adjustment);
    return;
  }

  if (entryType === "minus") {
    const uids = parseRemovedBoxIdsJson(adjustment.removed_box_ids);
    if (!uids.length) {
      const err = new Error("Select at least one box for minus adjustment.");
      err.statusCode = 400;
      throw err;
    }

    const rows = await findBoxesByUids(uids.map(String));
    const pn = String(adjustment.packing_number ?? "").trim();
    const live = (rows || []).filter(
      (r) => !r.is_deleted && boxBelongsToPackingNumber(r, pn)
    );
    if (live.length !== uids.length) {
      const err = new Error("Some boxes do not match this packing number or are deleted.");
      err.statusCode = 400;
      throw err;
    }
    const blocked = live.find((r) => !isBoxAvailableForMinus(r, { adjustmentId: adjId }));
    if (blocked) {
      const err = new Error(
        "Some boxes are not in hand — they may be dispatched or already removed via another adjustment."
      );
      err.statusCode = 400;
      throw err;
    }

    await markBoxesStockAdjustmentOutTx(client, {
      adjustmentId: adjId,
      boxUids: uids,
      userId,
      userName,
      packing_number: pn,
    });

    const sumQty = live.reduce((s, r) => s + (parseInt(r.qty, 10) || 0), 0);
    const { ledgerMap } = await getImsMapsSafe();
    await updateAdjustmentsTx(
      client,
      {
        box_count_impact: live.length,
        qty: -Math.abs(sumQty),
        removed_box_ids: buildMinusRemovedBoxIdsJson(live, pn, ledgerMap),
        acc_code: resolveAccCodeFromBoxRows(live),
      },
      { adjustment_id: adjId }
    );
    await persistAdjustmentDocDtTx(client, adjustment);
    return;
  }

  if (entryType === "update") {
    const plan = parseQtyUpdatePayload(adjustment.removed_box_ids);
    if (!plan) {
      const err = new Error("Update adjustment is missing box / qty plan.");
      err.statusCode = 400;
      throw err;
    }

    const rows = await findBoxesByUids([String(plan.box_uid)]);
    const box = (rows || []).find((r) => !r.is_deleted);
    if (!box) {
      const err = new Error("Box not found or was deleted.");
      err.statusCode = 400;
      throw err;
    }
    if (!isBoxInHand(box)) {
      const err = new Error(
        "Box is not in hand — it may be dispatched or removed via another adjustment."
      );
      err.statusCode = 400;
      throw err;
    }

    const liveQty = parseInt(String(box.qty ?? ""), 10);
    if (
      plan.snapshot_qty != null &&
      Number.isFinite(Number(plan.snapshot_qty)) &&
      Number.isFinite(liveQty) &&
      liveQty !== Number(plan.snapshot_qty)
    ) {
      const err = new Error(
        `Box qty changed since this update was saved (expected ${plan.snapshot_qty}, now ${liveQty}). Edit and save again before approve.`
      );
      err.statusCode = 400;
      throw err;
    }

    const { from, to, delta } = computeQtyUpdateResult(
      liveQty,
      plan.update_action,
      plan.update_qty
    );

    await updateBoxQtyForStockAdjustmentTx(client, {
      boxUid: plan.box_uid,
      qty: to,
      adjustmentId: adjId,
      userId,
      userName,
      details: {
        update_action: plan.update_action,
        update_qty: plan.update_qty,
        from_qty: from,
        to_qty: to,
      },
    });

    const stored = buildQtyUpdatePayload({
      box_uid: plan.box_uid,
      box_no_uid: plan.box_no_uid || box.box_no_uid,
      packing_number: plan.packing_number || box.packing_number,
      snapshot_qty: plan.snapshot_qty ?? from,
      update_action: plan.update_action,
      update_qty: plan.update_qty,
      applied_delta: delta,
      applied_from_qty: from,
      applied_to_qty: to,
    });

    await updateAdjustmentsTx(
      client,
      {
        qty: stored.signedDelta,
        per_box_qty: from,
        box_count_impact: 1,
        removed_box_ids: stored.json,
        packing_number:
          String(adjustment.packing_number ?? "").trim() ||
          String(box.packing_number ?? "").trim() ||
          null,
      },
      { adjustment_id: adjId }
    );
    await persistAdjustmentDocDtTx(client, adjustment);
  }
}

/** Undo box changes from an approved (or partially applied) adjustment — used on unapprove and delete. */
export async function revertStockAdjustmentOnUnapproveTx(client, { adjustment, userId, userName = null }) {
  if (!adjustment) return [];
  if (adjustment.entry_type === "add") {
    return await revertAddAdjustmentBoxesTx(client, { adjustmentId: adjustment.adjustment_id, userId });
  } else if (adjustment.entry_type === "minus") {
    return await revertMinusAdjustmentBoxesTx(client, { adjustment, userId, userName });
  } else if (adjustment.entry_type === "update") {
    return await revertUpdateAdjustmentBoxesTx(client, { adjustment, userId, userName });
  }
  return [];
}

async function revertUpdateAdjustmentBoxesTx(client, { adjustment, userId, userName = null }) {
  const plan = parseQtyUpdatePayload(adjustment.removed_box_ids);
  if (!plan?.box_uid) return [];

  const delta = plan.applied_delta;
  if (delta == null || !Number.isFinite(delta) || delta === 0) {
    // Never approved / never applied — nothing to undo on the live box.
    return [];
  }

  const rows = await findBoxesByUids([String(plan.box_uid)]);
  const box = (rows || []).find((r) => !r.is_deleted);
  if (!box) {
    const err = new Error("Cannot revert qty update — box not found or was deleted.");
    err.statusCode = 400;
    throw err;
  }

  const live = parseInt(String(box.qty ?? ""), 10) || 0;
  if (!isBoxInHand(box)) {
    const err = new Error(
      "Cannot revert qty update — box is not in hand (dispatched or removed)."
    );
    err.statusCode = 400;
    throw err;
  }

  const restored = live - delta;
  if (restored < 0) {
    const err = new Error(
      `Cannot revert qty update — restoring would make qty negative (live ${live}, delta ${delta}).`
    );
    err.statusCode = 400;
    throw err;
  }

  await updateBoxQtyForStockAdjustmentTx(client, {
    boxUid: plan.box_uid,
    qty: restored,
    adjustmentId: adjustment.adjustment_id,
    userId,
    userName,
    details: {
      update_action: "revert",
      applied_delta: delta,
      from_qty: live,
      to_qty: restored,
    },
  });

  const cleared = buildQtyUpdatePayload({
    box_uid: plan.box_uid,
    box_no_uid: plan.box_no_uid || box.box_no_uid,
    packing_number: plan.packing_number || box.packing_number,
    snapshot_qty: plan.snapshot_qty ?? plan.applied_from_qty ?? live,
    update_action: plan.update_action,
    update_qty: plan.update_qty,
    applied_delta: null,
    applied_from_qty: null,
    applied_to_qty: null,
  });

  await updateAdjustmentsTx(
    client,
    { removed_box_ids: cleared.json },
    { adjustment_id: adjustment.adjustment_id }
  );

  return [{ box_uid: plan.box_uid, box_no_uid: plan.box_no_uid || box.box_no_uid, qty: restored }];
}

/** Same inventory rollback as unapprove; delete controller soft-deletes the adjustment row after this. */
export const revertStockAdjustmentOnDeleteTx = revertStockAdjustmentOnUnapproveTx;
