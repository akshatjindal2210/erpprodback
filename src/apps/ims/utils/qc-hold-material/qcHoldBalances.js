import { flattenHoldRow, listSubmissions, parseHoldData, submissionToApi } from "./qcHoldData.js";

export function parseBoxUidList(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map((v) => String(v).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function attachQcHoldBalances(row, pendingTotals = {}) {
  const flat = flattenHoldRow(row);
  const d = parseHoldData(row.hold_data);
  const heldUids = d.boxes;
  const totalQty = Number(flat.qty) || 0;
  const totalBoxes = Number(flat.total_boxes) || heldUids.length;
  const completedQty = Number(flat.completed_qty) || 0;
  const completedBoxes = Number(flat.completed_boxes) || 0;
  const rejectedQty = Number(flat.rejected_qty) || 0;
  const rejectedBoxes = Number(flat.rejected_boxes) || 0;

  const balanceQty = Math.max(0, totalQty - completedQty - rejectedQty);
  const balanceBoxes = Math.max(0, totalBoxes - completedBoxes - rejectedBoxes);

  const pendingSubs = listSubmissions(row.hold_data, { pendingOnly: true }).map((s) =>
    submissionToApi(s, row.hold_id)
  );
  const approvedSubs = listSubmissions(row.hold_data, { approvedOnly: true }).map((s) =>
    submissionToApi(s, row.hold_id)
  );
  const pendingFromJson = {
    pending_count: pendingSubs.length,
    pending_completed_qty: pendingSubs.reduce((s, x) => s + (Number(x.completed_qty) || 0), 0),
    pending_completed_boxes: pendingSubs.reduce((s, x) => s + (Number(x.completed_boxes) || 0), 0),
    pending_rejected_qty: pendingSubs.reduce((s, x) => s + (Number(x.rejected_qty) || 0), 0),
    pending_rejected_boxes: pendingSubs.reduce((s, x) => s + (Number(x.rejected_boxes) || 0), 0),
  };

  const pending = { ...pendingFromJson, ...pendingTotals };

  return {
    ...flat,
    scanned_box_uids_list: heldUids,
    box_count: heldUids.length,
    total_qty: totalQty,
    total_boxes: totalBoxes,
    balance_qty: balanceQty,
    balance_boxes: balanceBoxes,
    pending_completed_qty: Number(pending.pending_completed_qty) || 0,
    pending_completed_boxes: Number(pending.pending_completed_boxes) || 0,
    pending_rejected_qty: Number(pending.pending_rejected_qty) || 0,
    pending_rejected_boxes: Number(pending.pending_rejected_boxes) || 0,
    pending_submission_count: Number(pending.pending_count) || 0,
    has_pending_submission: (Number(pending.pending_count) || 0) > 0,
    pending_submissions: pendingSubs,
    pending_submission_id: pendingSubs[0]?.submission_id ?? null,
    approved_submissions: approvedSubs,
    approved_submission_count: approvedSubs.length,
    last_approved_submission: approvedSubs.length ? approvedSubs[approvedSubs.length - 1] : null,
    pending_submission: pendingSubs[0] || null,
  };
}

export function deriveQcHoldStatus(row) {
  const balanceQty = Number(row.balance_qty) ?? 0;
  if (balanceQty <= 0) return "complete";
  const completedQty = Number(row.completed_qty) || 0;
  const rejectedQty = Number(row.rejected_qty) || 0;
  if (completedQty > 0 || rejectedQty > 0) return "partial";
  return "pending";
}
