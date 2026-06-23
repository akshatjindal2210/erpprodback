/**
 * Store Out — scan validation and draft/approved box linking.
 */

import { findBoxesByNoUids } from "../../models/box.model.js";
import {
  applyOutEntryApprovedStock,
  applyOutEntryOtherReturn,
  applyOutEntryQcAreaRelease,
  findOutEntryDraftBoxUids,
  saveOutEntryDraftScans,
} from "../../models/outEntry.model.js";
import {
  findScannedBoxUidsForOutEntry,
  isBoxEligibleForOutEntryInventoryOut,
  isBoxEligibleForOutEntryOther,
  isBoxEligibleForOutEntryQcArea,
} from "./outEntryFulfillment.js";
import {
  isBoxAvailableForOutEntryScan,
  isBoxInHand,
  isBoxOnQcHold,
} from "../box/boxInventory.js";
import { isOutEntryPackingArea, isOutEntryQcArea } from "./outEntryTypes.js";

const QC_HOLD_OUT_REJECT =
  "Some boxes are on QC hold — use QC Area out for that hold, or revert the hold first.";

export function normalizeOutEntryReasonInput(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text.slice(0, 200);
  }
  return null;
}

export async function scannedListForOut({ out_uid, scanned_boxes }) {
  if (scanned_boxes !== undefined) {
    return [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  }
  if (out_uid) return findScannedBoxUidsForOutEntry(out_uid);
  return [];
}

export async function validateOutEntryOtherScannedBoxes(scanned_boxes, forOutUid = null) {
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return "Scan at least one box.";
  const rows = await findBoxesByNoUids(uids);
  if (rows.length !== uids.length) {
    return "Some scanned boxes were not found or are deleted.";
  }
  const draftSet = new Set(forOutUid != null ? await findOutEntryDraftBoxUids(forOutUid) : []);
  const scopedOut =
    forOutUid != null && String(forOutUid).trim() !== "" ? Number(forOutUid) : null;
  const blocked = rows.find((r) => {
    if (isBoxOnQcHold(r)) return true;
    const uid = String(r.box_no_uid ?? "").trim();
    if (draftSet.has(uid)) return false;
    if (Number.isFinite(scopedOut) && Number(r.out_uid) === scopedOut) return false;
    return !isBoxEligibleForOutEntryOther(r);
  });
  if (blocked) {
    return isBoxOnQcHold(blocked) ? QC_HOLD_OUT_REJECT : "Some boxes are not in store or cannot be moved to packing area.";
  }
  return null;
}

export async function validateOutEntryQcAreaScannedBoxes(scanned_boxes, hold_id, forOutUid = null) {
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return "Scan at least one box.";
  const holdNum = Number(hold_id);
  if (!Number.isFinite(holdNum) || holdNum <= 0) return "QC hold is required.";
  const rows = await findBoxesByNoUids(uids);
  if (rows.length !== uids.length) {
    return "Some scanned boxes were not found or are deleted.";
  }
  const blocked = rows.find((r) => !isBoxEligibleForOutEntryQcArea(r, holdNum));
  if (blocked) {
    return "Some boxes are not in store on the selected QC hold or cannot be moved to QC area.";
  }
  return null;
}

export async function validateOutEntryInventoryOutScannedBoxes(scanned_boxes, forOutUid = null) {
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return "Scan at least one box.";
  const rows = await findBoxesByNoUids(uids);
  if (rows.length !== uids.length) {
    return "Some scanned boxes were not found or are deleted.";
  }
  const draftSet = new Set(forOutUid != null ? await findOutEntryDraftBoxUids(forOutUid) : []);
  const scopedOut =
    forOutUid != null && String(forOutUid).trim() !== "" ? Number(forOutUid) : null;
  const blocked = rows.find((r) => {
    if (isBoxOnQcHold(r)) return true;
    const uid = String(r.box_no_uid ?? "").trim();
    if (draftSet.has(uid)) return false;
    if (Number.isFinite(scopedOut) && Number(r.out_uid) === scopedOut) return false;
    return !isBoxEligibleForOutEntryInventoryOut(r);
  });
  if (blocked) {
    return isBoxOnQcHold(blocked) ? QC_HOLD_OUT_REJECT : "Some boxes are not in stock or cannot be removed.";
  }
  return null;
}

export async function validateOutEntryScannedBoxes(scanned_boxes, forOutUid = null) {
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return null;
  const rows = await findBoxesByNoUids(uids);
  if (rows.length !== uids.length) {
    return "Some scanned boxes were not found or are deleted.";
  }
  const draftSet = new Set(forOutUid != null ? await findOutEntryDraftBoxUids(forOutUid) : []);
  const scopedOut =
    forOutUid != null && String(forOutUid).trim() !== "" ? Number(forOutUid) : null;
  const blocked = rows.find((r) => {
    if (isBoxOnQcHold(r)) return true;
    if (isBoxInHand(r) && !isBoxOnQcHold(r)) return false;
    const uid = String(r.box_no_uid ?? "").trim();
    if (draftSet.has(uid)) return false;
    if (Number.isFinite(scopedOut) && Number(r.out_uid) === scopedOut) return false;
    return !isBoxAvailableForOutEntryScan(r, { forOutUid });
  });
  if (blocked) {
    return isBoxOnQcHold(blocked)
      ? QC_HOLD_OUT_REJECT
      : "Some boxes are not in stock — they may be outward or removed via stock adjustment.";
  }
  return null;
}

/** Draft = scan list only; approved = stock outward on ims_box_table (or packing area / QC release). */
export async function syncOutEntryBoxLinks(
  { out_uid, userId, scanned_boxes, approved, entry_type = "forwarding_note", qc_hold_id = null },
  { client = null } = {}
) {
  const list = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (isOutEntryQcArea(entry_type)) {
    if (approved && list.length) {
      await applyOutEntryQcAreaRelease(
        { out_uid, userId, scanned_boxes: list, qc_hold_id },
        { client }
      );
    } else {
      await saveOutEntryDraftScans({ out_uid, userId, scanned_boxes: list }, { client });
    }
    return list;
  }
  if (isOutEntryPackingArea(entry_type)) {
    if (approved && list.length) {
      await applyOutEntryOtherReturn({ out_uid, userId, scanned_boxes: list }, { client });
    } else {
      await saveOutEntryDraftScans({ out_uid, userId, scanned_boxes: list }, { client });
    }
    return list;
  }
  if (approved) {
    await applyOutEntryApprovedStock({ out_uid, userId, scanned_boxes: list }, { client });
  } else {
    await saveOutEntryDraftScans({ out_uid, userId, scanned_boxes: list }, { client });
  }
  return list;
}
