import { findCoilByUid, insertStockAdjustmentAddCoils, softDeleteStockAdjustmentAddCoils, softDeleteCoilsByCoilNoUids, buildStockAdjustmentAddCoilUidList, markCoilsStockAdjustmentOut, clearStockAdjustmentMinusMarks, findCoilsBySaId } from "../../../coil/models/coil.model.js";
import { updateAdjustment } from "../../models/stockAdjustment.model.js";
import { logCoilTransactionSafe } from "../../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../../lib/constants/coilTransactionTypes.js";
import { getBoxNoUidPrefix } from "../../../../../core/configuration/models/appConfig.model.js";
import { parseStoredCoilQtys, roundSaQty } from "../stockAdjustmentQty.js";
import { isSaAddLikeEntryType } from "../stockAdjustmentEntryTypes.js";
import { isCoilAvailableForSaMinus } from "../../../../lib/utils/saMinusInventory.js";
import { ensureMrnForStockAdjustment } from "../ensureMrnForStockAdjustment.js";

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
    /* comma-separated list */
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

/** Apply stock to inventory when an adjustment is approved. */
export async function applyStockAdjustmentOnApprove({ adjustment, userName, userId }) {
  const adjId = adjustment.adjustment_id;
  const entryType = String(adjustment.entry_type || "").toLowerCase();

  if (isSaAddLikeEntryType(entryType)) {
    const coilCount = parseInt(String(adjustment.coil_count_impact ?? ""), 10);
    const storedQtys = parseStoredCoilQtys(adjustment.coil_qtys);
    const perQty = Number(adjustment.per_coil_qty);
    const coilQtys =
      storedQtys.length === coilCount
        ? storedQtys
        : Number.isFinite(perQty) && perQty > 0
          ? Array.from({ length: coilCount }, () => roundSaQty(perQty))
          : null;

    if (!Number.isFinite(coilCount) || coilCount < 1 || !coilQtys?.length) {
      throw Object.assign(new Error("Add adjustment is missing coil count or quantities."), { statusCode: 400 });
    }
    if (!adjustment.item_dcode && !adjustment.item_code) {
      throw Object.assign(new Error("Add adjustment is missing the RM item."), { statusCode: 400 });
    }

    await ensureMrnForStockAdjustment(adjustment, userName);

    const uidPrefix = await getBoxNoUidPrefix();
    const plannedUids = buildStockAdjustmentAddCoilUidList({
      adjustmentId: adjId,
      coilCount,
      uidPrefix,
      mrn_no: adjustment.mrn_no,
      serial_no: adjustment.serial_no,
      mrn_uid: adjustment.mrn_uid,
    });

    // Clear prior SA add coils for this adjustment, then any active rows with the same UIDs
    // (handles failed partial approve or stale rows missing sa_entry_type).
    await softDeleteStockAdjustmentAddCoils(adjId, userName);
    if (plannedUids.length) {
      await softDeleteCoilsByCoilNoUids(plannedUids, userName);
    }

    let created;
    try {
      created = await insertStockAdjustmentAddCoils({
        adjustmentId: adjId,
        coilCount,
        perCoilQty: coilQtys.length === 1 ? coilQtys[0] : null,
        coilQtys,
        item_dcode: adjustment.item_dcode,
        item_code: adjustment.item_code,
        item_desc: adjustment.item_desc,
        heat_no: adjustment.heat_no,
        acc_code: adjustment.acc_code,
        acc_name: adjustment.acc_name,
        mrn_uid: adjustment.mrn_uid,
        mrn_no: adjustment.mrn_no,
        serial_no: adjustment.serial_no,
        uidPrefix,
        remarks: adjustment.remarks,
        userName,
      });
    } catch (err) {
      const dup =
        err?.code === "23505" ||
        /duplicate key|rmstore_coil_no_uid_unique_active/i.test(String(err?.message || ""));
      if (dup) {
        throw Object.assign(
          new Error(
            "Could not create coils — a coil UID already exists in inventory. Edit the adjustment, save, then approve again."
          ),
          { statusCode: 409, cause: err }
        );
      }
      throw err;
    }

    if (!created?.length) {
      throw Object.assign(
        new Error(
          "Could not create coils for this adjustment. Check MRN UID and coil quantities, then approve again."
        ),
        { statusCode: 500 }
      );
    }

    const qty = coilQtys.reduce((s, q) => s + roundSaQty(q), 0);
    await updateAdjustment(
      {
        coil_count_impact: coilCount,
        per_coil_qty: coilCount > 0 ? qty / coilCount : 0,
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
      details: { adjustment_id: adjId, entry_type: entryType, coil_count: coilCount, qty },
    });
    return created;
  }

  if (entryType === "minus") {
    const uids = parseRemovedCoilUids(adjustment.removed_coil_uids);
    if (!uids.length) {
      throw Object.assign(new Error("Select at least one coil for Minus."), { statusCode: 400 });
    }

    const live = [];
    for (const uid of uids) {
      const coil = await findCoilByUid(uid);
      if (!coil) {
        throw Object.assign(new Error(`Coil ${uid} was not found.`), { statusCode: 400 });
      }
      const status = String(coil.status || "active").toLowerCase();
      if (!isCoilAvailableForSaMinus(coil, { excludeAdjustmentId: adjId })) {
        throw Object.assign(new Error(`Coil ${uid} is not available (status: ${status}).`), { statusCode: 400 });
      }
      live.push(coil);
    }

    await clearStockAdjustmentMinusMarks(adjId, uids, userName);
    const marked = await markCoilsStockAdjustmentOut(adjId, uids, userName);
    if ((marked || []).length !== uids.length) {
      throw Object.assign(new Error("Could not mark all selected coils for Minus."), { statusCode: 500 });
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

  throw Object.assign(new Error(`Unknown adjustment type: ${entryType}.`), { statusCode: 400 });
}

/** Block edit/revert when SA Add coils are no longer active in stock (issued/consumed). */
export async function assertSaAddCoilsUnusedForEdit(adjustmentId) {
  const adjId = Number(adjustmentId);
  if (!Number.isFinite(adjId) || adjId <= 0) return;
  const coils = await findCoilsBySaId(adjId, "stock_in");
  const inUse = (coils || []).filter((c) => {
    if (c?.is_deleted) return false;
    const status = String(c?.status || "active").toLowerCase();
    return status !== "active";
  });
  if (!inUse.length) return;
  const sample = inUse
    .slice(0, 3)
    .map((c) => String(c.coil_no_uid || c.coil_uid || "").trim())
    .filter(Boolean)
    .join(", ");
  throw Object.assign(
    new Error(
      `Cannot edit — ${inUse.length} coil(s) already used (issued/consumed)${sample ? `: ${sample}` : ""}${inUse.length > 3 ? "…" : ""}.`
    ),
    { statusCode: 400 }
  );
}

/** Undo inventory when an approved adjustment is edited or deleted. */
export async function revertStockAdjustmentOnUnapprove({ adjustment, userName, userId }) {
  const adjId = adjustment.adjustment_id;
  const entryType = String(adjustment.entry_type || "").toLowerCase();

  if (isSaAddLikeEntryType(entryType)) {
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
        details: { adjustment_id: adjId, entry_type: entryType, reverted: n },
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
