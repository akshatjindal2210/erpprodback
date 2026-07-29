import { findCoilByUid, insertStockAdjustmentAddCoils, softDeleteStockAdjustmentAddCoils, markCoilsStockAdjustmentOut, clearStockAdjustmentMinusMarks, findCoilsBySaId } from "../../../coil/models/coil.model.js";
import { updateAdjustment } from "../../models/stockAdjustment.model.js";
import { logCoilTransactionSafe } from "../../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../../lib/constants/coilTransactionTypes.js";

export function parseRemovedCoilUids(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((u) => String(u || "").trim()).filter(Boolean))];
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((u) => String(u || "").trim()).filter(Boolean))];
    }
    if (parsed && Array.isArray(parsed.uids)) {
      return [...new Set(parsed.uids.map((u) => String(u || "").trim()).filter(Boolean))];
    }
  } catch {
    /* plain comma list */
  }
  return [
    ...new Set(
      String(raw)
        .split(/[,|\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

export function buildRemovedCoilUidsJson(uids = []) {
  return JSON.stringify([...new Set((uids || []).map((u) => String(u || "").trim()).filter(Boolean))]);
}

/** Apply inventory when adjustment is approved. */
export async function applyStockAdjustmentOnApprove({ adjustment, userName, userId }) {
  const adjId = adjustment.adjustment_id;
  const entryType = String(adjustment.entry_type || "").toLowerCase();

  if (entryType === "add") {
    await softDeleteStockAdjustmentAddCoils(adjId, userName);

    const n = parseInt(String(adjustment.coil_count_impact ?? ""), 10);
    const perQty = Number(adjustment.per_coil_qty);
    if (!Number.isFinite(n) || n < 1 || !Number.isFinite(perQty) || perQty <= 0) {
      const err = new Error("An Add adjustment needs a number of coils and a quantity per coil.");
      err.statusCode = 400;
      throw err;
    }
    if (!adjustment.item_dcode && !adjustment.item_code) {
      const err = new Error("An Add adjustment needs an RM item.");
      err.statusCode = 400;
      throw err;
    }

    const created = await insertStockAdjustmentAddCoils({
      adjustmentId: adjId,
      coilCount: n,
      perCoilQty: perQty,
      item_dcode: adjustment.item_dcode,
      item_code: adjustment.item_code,
      item_desc: adjustment.item_desc,
      heat_no: adjustment.heat_no,
      acc_code: adjustment.acc_code,
      acc_name: adjustment.acc_name,
      mrn_uid: adjustment.mrn_uid,
      mrn_no: adjustment.mrn_no,
      remarks: adjustment.remarks,
      userName,
    });

    const qty = n * perQty;
    await updateAdjustment(
      {
        coil_count_impact: n,
        per_coil_qty: perQty,
        qty,
        unit: adjustment.unit || "KG",
        doc_dt: adjustment.doc_dt || new Date(),
      },
      { adjustment_id: adjId }
    );

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.STOCK_ADJUSTMENT_ADD,
      source_module: "stock_adjustment",
      source_id: String(adjId),
      user_name: userName,
      user_id: userId,
      rows: created,
      details: { adjustment_id: adjId, entry_type: "add", coil_count: n, qty },
    });
    return created;
  }

  if (entryType === "minus") {
    const uids = parseRemovedCoilUids(adjustment.removed_coil_uids);
    if (!uids.length) {
      const err = new Error("Select at least one coil for a Minus adjustment.");
      err.statusCode = 400;
      throw err;
    }

    const live = [];
    for (const uid of uids) {
      const coil = await findCoilByUid(uid);
      if (!coil) {
        const err = new Error(`Coil ${uid} was not found.`);
        err.statusCode = 400;
        throw err;
      }
      const status = String(coil.status || "active").toLowerCase();
      const sameAdj =
        coil.sa_id != null && Number(coil.sa_id) === Number(adjId) && coil.sa_entry_type === "stock_out";
      if (status !== "active" && !sameAdj) {
        const err = new Error(`Coil ${uid} is not available for a Minus adjustment. Its current status is ${status}.`);
        err.statusCode = 400;
        throw err;
      }
      live.push(coil);
    }

    // Clear prior marks for this adj then re-apply
    await clearStockAdjustmentMinusMarks(adjId, uids, userName);
    const marked = await markCoilsStockAdjustmentOut(adjId, uids, userName);
    if ((marked || []).length !== uids.length) {
      const err = new Error("Could not mark all of the selected coils for the Minus adjustment. Please try again.");
      err.statusCode = 500;
      throw err;
    }

    const sumQty = live.reduce((s, c) => s + (Number(c.qty) || 0), 0);
    await updateAdjustment(
      {
        coil_count_impact: live.length,
        qty: -Math.abs(sumQty),
        removed_coil_uids: buildRemovedCoilUidsJson(uids),
        doc_dt: adjustment.doc_dt || new Date(),
      },
      { adjustment_id: adjId }
    );

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.STOCK_ADJUSTMENT_MINUS,
      source_module: "stock_adjustment",
      source_id: String(adjId),
      user_name: userName,
      user_id: userId,
      rows: marked,
      details: { adjustment_id: adjId, entry_type: "minus", coil_count: live.length, qty: -Math.abs(sumQty) },
    });
    return marked;
  }

  const err = new Error(`"${entryType}" is not a valid adjustment type.`);
  err.statusCode = 400;
  throw err;
}

/** Undo inventory from an approved adjustment (unapprove / delete). */
export async function revertStockAdjustmentOnUnapprove({ adjustment, userName, userId }) {
  const adjId = adjustment.adjustment_id;
  const entryType = String(adjustment.entry_type || "").toLowerCase();

  if (entryType === "add") {
    const existing = await findCoilsBySaId(adjId, "stock_in");
    const n = await softDeleteStockAdjustmentAddCoils(adjId, userName);
    if (existing.length) {
      logCoilTransactionSafe({
        transaction_type: COIL_TX_TYPES.STOCK_ADJUSTMENT_ADD_REVERT,
        source_module: "stock_adjustment",
        source_id: String(adjId),
        user_name: userName,
        user_id: userId,
        rows: existing,
        details: { adjustment_id: adjId, entry_type: "add", reverted: n },
      });
    }
    return;
  }

  if (entryType === "minus") {
    const uids = parseRemovedCoilUids(adjustment.removed_coil_uids);
    const existing = await findCoilsBySaId(adjId, "stock_out");
    const restored = await clearStockAdjustmentMinusMarks(adjId, uids, userName);
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.STOCK_ADJUSTMENT_MINUS_REVERT,
      source_module: "stock_adjustment",
      source_id: String(adjId),
      user_name: userName,
      user_id: userId,
      rows: restored?.length ? restored : existing,
      details: { adjustment_id: adjId, entry_type: "minus", restored: (restored || []).length },
    });
  }
}
