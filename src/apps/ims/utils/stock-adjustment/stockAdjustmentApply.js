import { findBoxesByUids, insertBulkBoxesTx, markBoxesStockAdjustmentOutTx, clearStockAdjustmentMinusMarksTx, findStockAdjustmentAddBoxesTx, permanentlyDeleteStockAdjustmentAddBoxesTx } from "../../models/box.model.js";
import { updateAdjustmentsTx } from "../../models/stockAdjustment.model.js";
import { getBoxNoUidPrefix } from "../../../core/models/appConfig.model.js";
import { buildStockAdjustmentAddBoxInsertRows, isLooseBoxComparedToStandard, resolveOverrideCustForPacking, resolveStandardQtyPerBoxForPacking } from "./stockAdjustmentPacking.js";
import { persistAdjustmentDocDtTx } from "./stockAdjustmentDocDt.js";
import { boxBelongsToPackingNumber, isBoxAvailableForMinus } from "../box/boxInventory.js";
import { resolveAccCodeFromBoxRows } from "../box/boxCustomerOverride.js";
import { buildMinusRemovedBoxIdsJson, parseRemovedBoxIdsJson } from "./minusRemovedBoxPayload.js";
import { getImsMapsSafe } from "../erp-api/imsLookup.js";

export { parseMinusRemovedBoxPayload, parseRemovedBoxIdsJson } from "./minusRemovedBoxPayload.js";

/** Undo minus marks when un-approving or before re-apply. */
export async function revertMinusAdjustmentBoxesTx(client, { adjustment, userId }) {
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
      userId
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
export async function applyStockAdjustmentOnApproveTx(client, { adjustment, userId }) {
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

    const itemDcode = parseInt(String(adjustment.item_dcode), 10);
    const standardPerBox = await resolveStandardQtyPerBoxForPacking({
      packingNumber,
      itemDcode: Number.isFinite(itemDcode) ? itemDcode : null
    });
    const isLooseEach = isLooseBoxComparedToStandard(pb, standardPerBox);
    const boxNoUidPrefix = await getBoxNoUidPrefix();
    const override_cust = adjustment.acc_code || (await resolveOverrideCustForPacking(packingNumber, {
      financialYear: adjustment.financial_year,
    }));
    const boxRows = buildStockAdjustmentAddBoxInsertRows({
      packingNumber,
      adjustmentId: adjId,
      totalBoxes: nb,
      perBoxQty: pb,
      isLoose: isLooseEach,
      userId,
      boxNoUidPrefix,
      override_cust,
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
  }
}

/** Undo box changes from an approved (or partially applied) adjustment — used on unapprove and delete. */
export async function revertStockAdjustmentOnUnapproveTx(client, { adjustment, userId }) {
  if (!adjustment) return [];
  if (adjustment.entry_type === "add") {
    return await revertAddAdjustmentBoxesTx(client, { adjustmentId: adjustment.adjustment_id, userId });
  } else if (adjustment.entry_type === "minus") {
    return await revertMinusAdjustmentBoxesTx(client, { adjustment, userId });
  }
  return [];
}

/** Same inventory rollback as unapprove; delete controller soft-deletes the adjustment row after this. */
export const revertStockAdjustmentOnDeleteTx = revertStockAdjustmentOnUnapproveTx;
