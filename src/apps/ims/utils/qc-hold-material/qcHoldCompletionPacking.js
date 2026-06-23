import { getBoxNoUidPrefix } from "../../../core/models/appConfig.model.js";
import { insertBulkBoxesTx, findQcHoldCompletionBoxesByPattern, findBoxByUidOrNoUid } from "../../models/box.model.js";
import { formatQcHoldBoxNoUid, qcHoldCompletionBoxTag } from "../box/boxUid.js";
import { resolveOverrideCustForPacking, resolveStandardQtyPerBoxForPacking } from "../stock-adjustment/stockAdjustmentPacking.js";
import { logBoxTransaction } from "../box/logBoxTransaction.js";
import { BOX_TX_TYPES } from "../../constants/boxTransactionTypes.js";
import { patchSubmissionCompletedBoxes } from "./qcHoldData.js";

/** Same math as packing sticker fetch — full boxes + optional loose. */
export function buildPackingConfigFromQty(totalQty, standardQtyPerBox) {
  const total = Number(totalQty) || 0;
  const std = Number(standardQtyPerBox) || 0;
  if (total <= 0 || std <= 0) return null;

  const fullBoxes = Math.floor(total / std);
  const looseQty = total % std;
  const totalStickers = fullBoxes + (looseQty > 0 ? 1 : 0);
  if (totalStickers <= 0) return null;

  return {
    qty_per_box: std,
    full_boxes_count: fullBoxes,
    loose_box_qty: looseQty > 0 ? Number(looseQty.toFixed(3)) : 0,
    total_stickers: totalStickers,
    total_qty: total,
  };
}

export function buildQcHoldCompletionBoxRows({
  packingNumber,
  holdId,
  packingConfig,
  userId,
  boxNoUidPrefix = "",
  override_cust = null,
}) {
  const pn = String(packingNumber ?? "").trim();
  const hid = parseInt(String(holdId), 10);
  const cfg = packingConfig;
  const total = parseInt(String(cfg?.total_stickers), 10);
  const fullCount = parseInt(String(cfg?.full_boxes_count), 10) || 0;
  if (!pn || !Number.isFinite(hid) || hid < 1 || !Number.isFinite(total) || total < 1) return [];

  const cust =
    override_cust != null && String(override_cust).trim() !== ""
      ? String(override_cust).trim()
      : null;

  const rows = [];
  for (let i = 1; i <= total; i++) {
    const isLoose = i > fullCount;
    rows.push({
      box_no_uid: formatQcHoldBoxNoUid(pn, hid, total, i, boxNoUidPrefix),
      packing_number: pn,
      qty: Number(isLoose ? cfg.loose_box_qty : cfg.qty_per_box),
      is_loose: isLoose,
      override_cust: cust,
      created_by: userId,
    });
  }
  return rows;
}

export async function createQcHoldCompletionBoxesTx(client, {
  hold,
  completedQty,
  userId,
  pendingUntilApproval = false,
}) {
  const qty = Math.max(0, parseInt(String(completedQty), 10) || 0);
  if (!qty) return { boxes: [], boxUids: [], completed_boxes: 0, packing_config: null };

  const holdId = Number(hold?.hold_id);
  const pn = String(hold?.packing_number ?? "").trim();
  const itemDcode = hold?.item_dcode != null ? parseInt(hold.item_dcode, 10) : null;
  if (!Number.isFinite(holdId) || holdId < 1 || !pn) {
    const err = new Error("Hold packing context missing for sticker creation.");
    err.statusCode = 400;
    throw err;
  }

  const standardPerBox = await resolveStandardQtyPerBoxForPacking({
    packingNumber: pn,
    itemDcode: Number.isFinite(itemDcode) ? itemDcode : null,
  });
  if (!standardPerBox) {
    const err = new Error("No packing standard qty found for this packing.");
    err.statusCode = 400;
    throw err;
  }

  const packingConfig = buildPackingConfigFromQty(qty, standardPerBox);
  if (!packingConfig?.total_stickers) {
    const err = new Error("Could not build sticker layout for completed quantity.");
    err.statusCode = 400;
    throw err;
  }

  const boxNoUidPrefix = await getBoxNoUidPrefix();
  const override_cust = await resolveOverrideCustForPacking(pn, {});
  const insertRows = buildQcHoldCompletionBoxRows({
    packingNumber: pn,
    holdId,
    packingConfig,
    userId,
    boxNoUidPrefix,
    override_cust,
  });

  let inserted = await insertBulkBoxesTx(client, insertRows);
  if (inserted?.length && pendingUntilApproval) {
    const boxUidInts = inserted.map((b) => Number(b.box_uid)).filter((n) => Number.isFinite(n) && n > 0);
    if (boxUidInts.length) {
      const { rows: held } = await client.query(
        `UPDATE ims_box_table
         SET qc_hold_id = $1::integer,
             updated_at = NOW()
         WHERE box_uid = ANY($2::int[])
           AND is_deleted = false
         RETURNING *`,
        [holdId, boxUidInts]
      );
      inserted = held || inserted;
    }
  }

  if (inserted?.length) {
    await logBoxTransaction({
      client,
      transaction_type: BOX_TX_TYPES.QC_HOLD_COMPLETE,
      source_module: "qc_hold_material",
      source_id: String(holdId),
      packing_number: pn,
      user_id: userId,
      rows: inserted,
      details: {
        completed_qty: qty,
        packing_config: packingConfig,
        pending_until_approval: !!pendingUntilApproval,
      },
    });
  }

  const boxUids = (inserted || []).map((b) => String(b.box_no_uid).trim()).filter(Boolean);
  return {
    boxes: inserted || [],
    boxUids,
    completed_boxes: boxUids.length,
    packing_config: packingConfig,
  };
}

/** Release completion stickers into sellable stock after submission approval. */
export async function activateQcHoldCompletionBoxesTx(client, { holdId, boxUids = [], userId }) {
  const pk = Number(holdId);
  const uids = [...new Set((boxUids || []).map((v) => String(v).trim()).filter(Boolean))];
  if (!Number.isFinite(pk) || pk < 1 || !uids.length) {
    return { boxes: [], boxUids: [], completed_boxes: 0, packing_config: null };
  }

  const numericOnly = uids.filter((c) => /^\d+$/.test(c));
  const { rows } = await client.query(
    `UPDATE ims_box_table b
     SET qc_hold_id = NULL,
         updated_at = NOW()
     WHERE b.is_deleted = false
       AND b.qc_hold_id = $1::integer
       AND (
         b.box_no_uid::text = ANY($2::text[])
         OR (cardinality($3::text[]) > 0 AND b.box_uid::text = ANY($3::text[]))
       )
     RETURNING b.*`,
    [pk, uids, numericOnly]
  );

  if (rows?.length) {
    await logBoxTransaction({
      client,
      transaction_type: BOX_TX_TYPES.QC_HOLD_COMPLETE,
      source_module: "qc_hold_material",
      source_id: String(pk),
      packing_number: rows[0]?.packing_number,
      user_id: userId,
      rows,
      details: { activated: true, box_uids: uids },
    });
  }

  const activatedUids = (rows || []).map((b) => String(b.box_no_uid).trim()).filter(Boolean);
  return {
    boxes: rows || [],
    boxUids: activatedUids,
    completed_boxes: activatedUids.length,
    packing_config: null,
  };
}

/** Soft-delete all completion stickers for a hold (revert cleanup or delete hold). */
export async function softDeleteQcHoldCompletionBoxesByHoldTx(client, { holdId, userId, requireOnHold = false } = {}) {
  const pk = Number(holdId);
  if (!Number.isFinite(pk) || pk < 1) return { deleted: 0 };

  const tag = qcHoldCompletionBoxTag(pk);
  const sql = requireOnHold
    ? `UPDATE ims_box_table b
       SET is_deleted = true,
           deleted_at = NOW(),
           deleted_by = $2,
           qc_hold_id = NULL,
           updated_at = NOW()
       WHERE b.is_deleted = false
         AND b.qc_hold_id = $1::integer
         AND position($3::text IN b.box_no_uid::text) > 0
       RETURNING b.box_uid, b.box_no_uid, b.packing_number, b.qty, b.is_loose`
    : `UPDATE ims_box_table b
       SET is_deleted = true,
           deleted_at = NOW(),
           deleted_by = $1,
           qc_hold_id = NULL,
           updated_at = NOW()
       WHERE b.is_deleted = false
         AND position($2::text IN b.box_no_uid::text) > 0
       RETURNING b.box_uid, b.box_no_uid, b.packing_number, b.qty, b.is_loose`;
  const params = requireOnHold ? [pk, userId ?? null, tag] : [userId ?? null, tag];
  const { rows } = await client.query(sql, params);

  if (rows?.length) {
    await logBoxTransaction({
      client,
      transaction_type: BOX_TX_TYPES.QC_HOLD_COMPLETE,
      source_module: "qc_hold_material",
      source_id: String(pk),
      packing_number: rows[0]?.packing_number,
      user_id: userId,
      rows,
      details: {
        deleted_pending_completion: !!requireOnHold,
        deleted_on_revert: !requireOnHold,
      },
    });
  }

  return { deleted: rows?.length || 0 };
}

/** Remove unapproved completion stickers when the hold is deleted. */
export async function softDeletePendingQcHoldCompletionBoxesTx(client, { holdId, userId }) {
  return softDeleteQcHoldCompletionBoxesByHoldTx(client, { holdId, userId, requireOnHold: true });
}

function submissionBoxUids(submission) {
  return Array.isArray(submission?.completed_box_uids)
    ? submission.completed_box_uids.map((v) => String(v).trim()).filter(Boolean)
    : [];
}

/** Create completion stickers on first print — pending until submission is approved. */
export async function ensureQcHoldSubmissionCompletionBoxesTx(client, { hold, submission, userId }) {
  if (String(submission?.submission_type ?? "").trim().toLowerCase() === "revert") {
    return { boxes: [], holdData: null, packing_config: null, created: false };
  }

  const completedQty = Math.max(0, parseInt(String(submission?.completed_qty), 10) || 0);
  const sid = Number(submission?.submission_id);
  if (!completedQty || !Number.isFinite(sid) || sid < 1) {
    return { boxes: [], holdData: null, packing_config: null, created: false };
  }

  const existingUids = submissionBoxUids(submission);
  if (existingUids.length > 0) {
    const existing = await listQcHoldCompletionBoxes({ hold, submission });
    if (existing.length > 0) {
      return { boxes: existing, holdData: null, packing_config: null, created: false };
    }
  }

  const completionResult = await createQcHoldCompletionBoxesTx(client, {
    hold,
    completedQty,
    userId,
    pendingUntilApproval: !submission.approved,
  });

  const holdData = patchSubmissionCompletedBoxes(hold.hold_data, sid, {
    boxUids: completionResult.boxUids,
    completedBoxes: completionResult.completed_boxes,
  });

  const boxes = await listQcHoldCompletionBoxes({
    hold,
    submission: {
      ...submission,
      completed_box_uids: completionResult.boxUids,
    },
  });

  return {
    boxes,
    holdData,
    packing_config: completionResult.packing_config,
    created: true,
  };
}

export async function consumeQcHoldSourceQtyTx(client, { holdId, sourceBoxUids = [], completedQty, userId }) {
  const pk = Number(holdId);
  const targetQty = Math.max(0, parseInt(String(completedQty), 10) || 0);
  const uids = [...new Set((sourceBoxUids || []).map((v) => String(v).trim()).filter(Boolean))];
  if (!Number.isFinite(pk) || pk < 1 || targetQty <= 0 || !uids.length) {
    return { deleted: 0, consumedUids: [], consumedQty: 0 };
  }

  const numericOnly = uids.filter((c) => /^\d+$/.test(c));
  const { rows: candidates } = await client.query(
    `SELECT b.box_uid, b.box_no_uid, b.packing_number, b.qty, b.is_loose
     FROM ims_box_table b
     WHERE b.is_deleted = false
       AND b.qc_hold_id = $1::integer
       AND (
         b.box_no_uid::text = ANY($2::text[])
         OR (cardinality($3::text[]) > 0 AND b.box_uid::text = ANY($3::text[]))
       )
     ORDER BY b.box_uid ASC`,
    [pk, uids, numericOnly]
  );

  let need = targetQty;
  const toConsume = [];
  for (const box of candidates || []) {
    if (need <= 0) break;
    toConsume.push(box);
    need -= Number(box.qty) || 0;
  }
  if (!toConsume.length) {
    return { deleted: 0, consumedUids: [], consumedQty: 0 };
  }

  const consumeUids = toConsume.map((b) => String(b.box_no_uid).trim()).filter(Boolean);
  const consumeNumeric = consumeUids.filter((c) => /^\d+$/.test(c));
  const { rows } = await client.query(
    `UPDATE ims_box_table b
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $4,
         qc_hold_id = NULL,
         updated_at = NOW()
     WHERE b.is_deleted = false
       AND b.qc_hold_id = $1::integer
       AND (
         b.box_no_uid::text = ANY($2::text[])
         OR (cardinality($3::text[]) > 0 AND b.box_uid::text = ANY($3::text[]))
       )
     RETURNING b.box_uid, b.box_no_uid, b.packing_number, b.qty, b.is_loose`,
    [pk, consumeUids, consumeNumeric, userId ?? null]
  );

  if (rows?.length) {
    await logBoxTransaction({
      client,
      transaction_type: BOX_TX_TYPES.QC_HOLD_SOURCE_CONSUME,
      source_module: "qc_hold_material",
      source_id: String(pk),
      packing_number: rows[0]?.packing_number,
      user_id: userId,
      rows,
      details: { source_box_uids: consumeUids, completed_qty: targetQty, partial: true },
    });
  }

  const consumedQty = (rows || []).reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
  return {
    deleted: rows?.length || 0,
    consumedUids: consumeUids,
    consumedQty,
  };
}

export async function consumeQcHoldSourceBoxesTx(client, { holdId, sourceBoxUids = [], userId }) {
  const pk = Number(holdId);
  const uids = [...new Set((sourceBoxUids || []).map((v) => String(v).trim()).filter(Boolean))];
  if (!Number.isFinite(pk) || pk < 1) return { deleted: 0 };

  if (!uids.length) return { deleted: 0 };

  const numericOnly = uids.filter((c) => /^\d+$/.test(c));
  const { rows } = await client.query(
    `UPDATE ims_box_table b
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $3,
         qc_hold_id = NULL,
         updated_at = NOW()
     WHERE b.is_deleted = false
       AND b.qc_hold_id = $1::integer
       AND (
         b.box_no_uid::text = ANY($2::text[])
         OR (cardinality($4::text[]) > 0 AND b.box_uid::text = ANY($4::text[]))
       )
     RETURNING b.box_uid, b.box_no_uid, b.packing_number, b.qty, b.is_loose`,
    [pk, uids, userId ?? null, numericOnly]
  );

  if (rows?.length) {
    await logBoxTransaction({
      client,
      transaction_type: BOX_TX_TYPES.QC_HOLD_SOURCE_CONSUME,
      source_module: "qc_hold_material",
      source_id: String(pk),
      packing_number: rows[0]?.packing_number,
      user_id: userId,
      rows,
      details: { source_box_uids: uids },
    });
  }

  return { deleted: rows?.length || 0 };
}

export async function listQcHoldCompletionBoxes({ hold, submission = null }) {
  const holdId = Number(hold?.hold_id);
  const pn = String(hold?.packing_number ?? "").trim();
  if (!Number.isFinite(holdId) || holdId < 1 || !pn) return [];

  const rows = await findQcHoldCompletionBoxesByPattern(pn, holdId);
  const submissionUids = new Set(
    (Array.isArray(submission?.completed_box_uids)
      ? submission.completed_box_uids
      : typeof submission?.completed_box_uids === "string"
        ? (() => {
            try {
              const parsed = JSON.parse(submission.completed_box_uids);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })()
        : []
    ).map((v) => String(v).trim()).filter(Boolean)
  );

  const filtered =
    submissionUids.size > 0
      ? rows.filter((r) => submissionUids.has(String(r.box_no_uid).trim()))
      : rows;

  return filtered.map((row, idx) => ({
    ...row,
    box_no: idx + 1,
    package_no: pn,
    total_boxes: filtered.length,
    unit: row.unit || "PCS",
  }));
}

function mapPrintStickerRows(rows, packingNumber) {
  const pn = String(packingNumber ?? "").trim();
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  return list.map((row, idx) => ({
    ...row,
    box_no: idx + 1,
    package_no: pn || row.packing_number,
    total_boxes: list.length,
    unit: row.unit || "PCS",
  }));
}

/** Original source boxes for revert (no change) — same stickers as before the hold. */
export async function listQcHoldRevertSourceBoxes({ hold, submission = null }) {
  if (String(submission?.submission_type ?? "").trim().toLowerCase() !== "revert") return [];

  const uids = submissionBoxUids(submission);
  if (!uids.length) return [];

  const pn = String(hold?.packing_number ?? "").trim();
  const boxes = [];
  for (const uid of uids) {
    const box = await findBoxByUidOrNoUid(uid);
    if (box && !box.is_deleted) boxes.push(box);
  }

  return mapPrintStickerRows(boxes, pn);
}

/** Completion stickers for pass/full flows, or original boxes for revert. */
export async function listQcHoldPrintStickers({ hold, submission = null }) {
  const submissionType = String(submission?.submission_type ?? "").trim().toLowerCase();
  if (submissionType === "revert") {
    return listQcHoldRevertSourceBoxes({ hold, submission });
  }
  return listQcHoldCompletionBoxes({ hold, submission });
}
