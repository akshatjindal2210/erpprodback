import dbQuery from "../../../../config/db.js";
import {
  findBoxByUidOrNoUid,
  findSellableInHandBoxesByPackingNumber,
  setBoxesQcHold,
  clearBoxesQcHold,
  syncBoxesQcHold,
} from "../../models/box.model.js";
import { isBoxSellable, isBoxOnQcHold, isBoxInStore, boxBelongsToPackingNumber } from "../box/boxInventory.js";
import {
  qcHoldBoxNotFound,
  qcHoldBoxAlreadyOnHold,
  qcHoldBoxNotSellable,
  qcHoldBoxWrongPacking,
} from "../../constants/qcHoldMaterial.messages.js";
import { QC_HOLD_PARTIAL_ENABLED } from "../../constants/qcHoldFeatureFlags.js";
import { logBoxTransaction, logBoxTransactionSafe, singlePackingFromRows } from "../box/logBoxTransaction.js";
import { BOX_TX_TYPES } from "../../constants/boxTransactionTypes.js";
import { qcHoldCompletionBoxTag } from "../box/boxUid.js";

export const QC_HOLD_SCAN_PARTIAL = "partial";
export const QC_HOLD_SCAN_FULL = "full";

export function normalizeHoldScanMode(mode, { legacyMode = null } = {}) {
  const legacy = String(legacyMode ?? "").trim().toLowerCase();
  if (!QC_HOLD_PARTIAL_ENABLED) {
    // Keep existing partial holds editable without expanding to full packing on save.
    if (legacy === QC_HOLD_SCAN_PARTIAL) return QC_HOLD_SCAN_PARTIAL;
    return QC_HOLD_SCAN_FULL;
  }
  const m = String(mode ?? "").trim().toLowerCase();
  return m === QC_HOLD_SCAN_FULL ? QC_HOLD_SCAN_FULL : QC_HOLD_SCAN_PARTIAL;
}

/** Keep only boxes that are in-hand sellable stock (same rules as inventory). */
async function uidsForSellableInHand(boxUids = []) {
  const out = [];
  for (const uid of boxUids) {
    const box = await findBoxByUidOrNoUid(uid);
    if (!box || box.is_deleted || !isBoxSellable(box)) continue;
    const id = String(box.box_no_uid ?? box.box_uid ?? uid).trim();
    if (id) out.push(id);
  }
  return [...new Set(out)];
}

export async function resolveHoldBoxUids({
  holdScanMode,
  scannedUids = [],
  packingNumber = null,
} = {}) {
  const mode = normalizeHoldScanMode(holdScanMode);
  const list = [...new Set((scannedUids || []).map((v) => String(v).trim()).filter(Boolean))];
  if (!list.length) return [];

  if (mode === QC_HOLD_SCAN_FULL) {
    const pn = String(packingNumber ?? "").trim();
    if (!pn) return list;
    const boxes = await findSellableInHandBoxesByPackingNumber(pn);
    const expanded = (boxes || [])
      .map((b) => String(b.box_no_uid ?? b.box_uid ?? "").trim())
      .filter(Boolean);
    return expanded;
  }

  return uidsForSellableInHand(list);
}

export async function validateBoxesForHold(boxUids = [], { holdId = null, packingNumber = null } = {}) {
  const pk = holdId != null ? Number(holdId) : null;
  const pn = packingNumber != null ? String(packingNumber).trim() : "";

  for (const uid of boxUids) {
    const box = await findBoxByUidOrNoUid(uid);
    if (!box || box.is_deleted) {
      return qcHoldBoxNotFound(uid);
    }
    if (!isBoxSellable(box)) {
      if (isBoxOnQcHold(box)) {
        const onSameHold = Number.isFinite(pk) && pk > 0 && Number(box.qc_hold_id) === pk;
        if (!onSameHold) {
          return qcHoldBoxAlreadyOnHold(box.box_no_uid, uid);
        }
        continue;
      }
      return qcHoldBoxNotSellable(box.box_no_uid, uid);
    }
    if (pn && !boxBelongsToPackingNumber(box, pn)) {
      return qcHoldBoxWrongPacking(box.box_no_uid, uid, box.packing_number, pn);
    }
  }
  return null;
}

function logQcHoldApplyBatch({ holdId, userId = null, rows = [] }) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return;

  const storeInRows = list.filter((row) => isBoxInStore(row));
  const packingAreaRows = list.filter((row) => !isBoxInStore(row));

  if (storeInRows.length) {
    logBoxTransactionSafe({
      transaction_type: BOX_TX_TYPES.QC_HOLD_APPLY,
      source_module: "qc_hold_material",
      source_id: String(holdId),
      packing_number: singlePackingFromRows(storeInRows),
      user_id: userId,
      rows: storeInRows,
      details: { hold_id: holdId, in_store: true },
    });
  }

  if (packingAreaRows.length) {
    logBoxTransactionSafe({
      transaction_type: BOX_TX_TYPES.OUT_QC_AREA_RELEASE,
      source_module: "qc_hold_material",
      source_id: String(holdId),
      packing_number: singlePackingFromRows(packingAreaRows),
      user_id: userId,
      rows: packingAreaRows,
      details: {
        hold_id: holdId,
        qc_hold_id: holdId,
        entry_type: "qc_area",
        moved_to_qc_area: true,
        from_packing_area_at_hold: true,
        packing_numbers: [...new Set(packingAreaRows.map((r) => r.packing_number).filter(Boolean))],
        box_count: packingAreaRows.length,
      },
    });
  }
}

function normalizeHoldBoxUidList(boxUids = []) {
  return [...new Set((boxUids || []).map((v) => String(v).trim()).filter(Boolean))];
}

const REVERTABLE_BOX_SQL = `
  b.is_deleted = false
  AND position($2::text IN b.box_no_uid::text) = 0
  AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
  AND NOT (
    b.sa_id IS NOT NULL
    AND b.out_uid IS NOT NULL
    AND b.out_uid::text = b.sa_id::text
  )
`;

/** Boxes that can still be released on revert (on hold, or hold-listed boxes that were outward-linked). */
export async function countRevertableBoxesForHold(holdId, sourceBoxUids = []) {
  const pk = Number(holdId);
  if (!Number.isFinite(pk) || pk < 1) return 0;

  const qchTag = qcHoldCompletionBoxTag(pk);
  const uids = normalizeHoldBoxUidList(sourceBoxUids);
  const numericOnly = uids.filter((c) => /^\d+$/.test(c));

  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS c
     FROM ims_box_table b
     WHERE ${REVERTABLE_BOX_SQL}
       AND (
         b.qc_hold_id = $1::integer
         OR (
           cardinality($3::text[]) > 0
           AND (
             b.box_no_uid::text = ANY($3::text[])
             OR (cardinality($4::text[]) > 0 AND b.box_uid::text = ANY($4::text[]))
           )
           AND (
             b.qc_hold_id = $1::integer
             OR b.out_uid IS NOT NULL
           )
         )
       )`,
    [pk, qchTag, uids, numericOnly]
  );
  return Number(row?.c) || 0;
}

export async function releaseQcHoldRevertTx(client, { holdId, userId, sourceBoxUids = [] } = {}) {
  const pk = Number(holdId);
  if (!Number.isFinite(pk) || pk < 1) return { released: 0, boxes: [] };

  const qchTag = qcHoldCompletionBoxTag(pk);
  const uids = normalizeHoldBoxUidList(sourceBoxUids);
  const numericOnly = uids.filter((c) => /^\d+$/.test(c));

  const releaseSql = `
    UPDATE ims_box_table b
    SET qc_hold_id = NULL,
        out_uid = NULL,
        updated_at = NOW()
    WHERE ${REVERTABLE_BOX_SQL}
      AND (
        b.qc_hold_id = $1::integer
        OR (
          cardinality($3::text[]) > 0
          AND (
            b.box_no_uid::text = ANY($3::text[])
            OR (cardinality($4::text[]) > 0 AND b.box_uid::text = ANY($4::text[]))
          )
          AND (
            b.qc_hold_id = $1::integer
            OR b.out_uid IS NOT NULL
          )
        )
      )
    RETURNING b.*`;

  const params = [pk, qchTag, uids, numericOnly];
  let { rows } = await client.query(releaseSql, params);

  if (rows?.length) {
    await logBoxTransaction({
      client,
      transaction_type: BOX_TX_TYPES.QC_HOLD_REVERT,
      source_module: "qc_hold_material",
      source_id: String(pk),
      packing_number: rows[0]?.packing_number,
      user_id: userId,
      rows,
      details: {
        revert_no_change: true,
        released_boxes: rows.length,
        restored_from_hold_data: uids.length > 0,
      },
    });
  }

  return { released: rows?.length || 0, boxes: rows || [] };
}

export async function applyQcHoldToBoxes(holdId, boxUids = [], { userId = null } = {}) {
  const err = await validateBoxesForHold(boxUids, { holdId });
  if (err) throw new Error(err);
  const { rows } = await setBoxesQcHold(holdId, boxUids);
  logQcHoldApplyBatch({ holdId, userId, rows });
}

export async function releaseQcHoldFromBoxes(holdId) {
  await clearBoxesQcHold(holdId);
}

export async function syncQcHoldBoxStock(holdId, prevUids = [], nextUids = [], { userId = null } = {}) {
  const err = await validateBoxesForHold(nextUids, { holdId });
  if (err) throw new Error(err);
  const { appliedRows } = await syncBoxesQcHold(holdId, prevUids, nextUids);
  logQcHoldApplyBatch({ holdId, userId, rows: appliedRows });
}

export async function expandFullHoldBoxesForPacking(packingNumber) {
  const pn = String(packingNumber ?? "").trim();
  if (!pn) return [];
  // In-hand sellable stock only — excludes outward/dispatch and boxes already on QC hold.
  const boxes = await findSellableInHandBoxesByPackingNumber(pn);
  return (boxes || []).map((b) => ({
    box_no_uid: b.box_no_uid,
    box_uid: b.box_uid,
    packing_number: b.packing_number,
    qty: Number(b.qty) || 0,
    location_no: b.location_no ?? null,
  }));
}
