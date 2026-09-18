import { getBoxNoUidPrefix } from "../../../../core/configuration/models/appConfig.model.js";
import { formatStockAdjustmentCoilUid } from "../../../lib/coilUidFormat.js";
import { resolveSerialNoForUid } from "../../../lib/coilUidHelpers.js";
import { parseStoredCoilQtys, roundSaQty } from "./stockAdjustmentQty.js";
import { isSaAddLikeEntryType } from "./stockAdjustmentEntryTypes.js";
import { parseRemovedCoilUids } from "./apply/stockAdjustmentApply.js";

/** Preview coil rows for pending Add (+) / Old adjustments (no DB coils yet). */
export async function buildPendingAddPreviewCoils(row) {
  if (!isSaAddLikeEntryType(String(row?.entry_type || ""))) return [];
  const n = parseInt(String(row?.coil_count_impact ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return [];
  const qtys = parseStoredCoilQtys(row?.coil_qtys);
  const per = Number(row?.per_coil_qty);
  const list =
    qtys.length === n
      ? qtys
      : Number.isFinite(per) && per > 0
        ? Array.from({ length: n }, () => roundSaQty(per))
        : [];
  const prefix = await getBoxNoUidPrefix();
  const serial_no = resolveSerialNoForUid({ serial_no: row?.serial_no, mrn_uid: row?.mrn_uid });
  const mrn_no = row?.mrn_no ?? null;
  return list.map((qty, i) => ({
    coil_no_uid: formatStockAdjustmentCoilUid({
      prefix,
      mrn_no,
      serial_no,
      adjustment_id: row?.adjustment_id,
      total: n,
      index: i + 1,
    }),
    index: i + 1,
    qty: roundSaQty(qty),
    heat_no: row?.heat_no ?? null,
    mrn_uid: row?.mrn_uid ?? null,
    mrn_no,
    item_code: row?.item_code ?? null,
    item_desc: row?.item_desc ?? null,
    preview: true,
  }));
}

/** Expected coil UIDs that must be scanned before approve. */
export async function getExpectedSaApproveScanUids(adjustment) {
  const entryType = String(adjustment?.entry_type || "").toLowerCase();
  if (isSaAddLikeEntryType(entryType)) {
    const preview = await buildPendingAddPreviewCoils(adjustment);
    return preview.map((c) => String(c.coil_no_uid || "").trim()).filter(Boolean);
  }
  if (entryType === "minus") {
    return parseRemovedCoilUids(adjustment?.removed_coil_uids)
      .map((uid) => String(uid || "").trim())
      .filter(Boolean);
  }
  return [];
}

export function assertScannedCoilsForSaApprove(expectedUids, scannedRaw) {
  const expected = [...new Set((expectedUids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!expected.length) {
    const err = new Error("No coils are defined for this adjustment — cannot approve.");
    err.statusCode = 400;
    throw err;
  }
  const scanned = Array.isArray(scannedRaw)
    ? scannedRaw.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  if (!scanned.length) {
    const err = new Error("Scan all coil stickers before approving.");
    err.statusCode = 400;
    throw err;
  }
  const scannedSet = new Set(scanned);
  const missing = expected.filter((uid) => !scannedSet.has(uid));
  if (missing.length) {
    const err = new Error(
      `Scan all coil stickers before approving. Missing ${missing.length} of ${expected.length}.`
    );
    err.statusCode = 400;
    throw err;
  }
  const extra = scanned.filter((uid) => !expected.includes(uid));
  if (extra.length) {
    const err = new Error("A scanned coil UID does not belong to this stock adjustment.");
    err.statusCode = 400;
    throw err;
  }
}
