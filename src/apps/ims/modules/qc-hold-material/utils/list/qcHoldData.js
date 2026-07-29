/** QC hold payload — boxes, balances, submissions live in hold_data JSONB. */

export const QC_HOLD_TYPE_PENDING = "pending_hold";
export const QC_HOLD_SCAN_PARTIAL = "partial";
export const QC_HOLD_SCAN_FULL = "full";

export function emptyHoldData() {
  return {
    hold_type: QC_HOLD_TYPE_PENDING,
    boxes: [],
    qty: 0,
    total_boxes: 0,
    completed_qty: 0,
    completed_boxes: 0,
    rejected_qty: 0,
    rejected_boxes: 0,
    submissions: [],
  };
}

export function parseHoldData(raw) {
  if (!raw) return emptyHoldData();
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return emptyHoldData();
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return emptyHoldData();

  const legacyBoxes = parseLegacyBoxList(data);
  const boxes = Array.isArray(data.boxes)
    ? data.boxes.map((v) => String(v).trim()).filter(Boolean)
    : legacyBoxes;

  const submissions = Array.isArray(data.submissions)
    ? data.submissions.filter((s) => s && !s.is_deleted)
    : [];

  return {
    hold_type: String(data.hold_type || QC_HOLD_TYPE_PENDING).trim() || QC_HOLD_TYPE_PENDING,
    boxes,
    qty: Number(data.qty) || 0,
    total_boxes: Number(data.total_boxes) || boxes.length,
    completed_qty: Number(data.completed_qty) || 0,
    completed_boxes: Number(data.completed_boxes) || 0,
    rejected_qty: Number(data.rejected_qty) || 0,
    rejected_boxes: Number(data.rejected_boxes) || 0,
    submissions,
    hold_scan_mode: String(data.hold_scan_mode || QC_HOLD_SCAN_PARTIAL).trim() || QC_HOLD_SCAN_PARTIAL,
  };
}

function parseLegacyBoxList(data) {
  const raw = data.scanned_box_uids ?? data.box_uids;
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (raw == null || raw === "") return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map((v) => String(v).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function serializeHoldData(data) {
  const d = parseHoldData(data);
  return JSON.stringify({
    hold_type: d.hold_type,
    boxes: d.boxes,
    qty: d.qty,
    total_boxes: d.total_boxes || d.boxes.length,
    completed_qty: d.completed_qty,
    completed_boxes: d.completed_boxes,
    rejected_qty: d.rejected_qty,
    rejected_boxes: d.rejected_boxes,
    submissions: (d.submissions || []).map((s) => ({
      submission_id: Number(s.submission_id) || 0,
      submission_type: String(s.submission_type || "").trim(),
      completed_box_uids: Array.isArray(s.completed_box_uids)
        ? s.completed_box_uids.map((v) => String(v).trim()).filter(Boolean)
        : parseLegacyBoxList(s),
      completed_qty: Number(s.completed_qty) || 0,
      completed_boxes: Number(s.completed_boxes) || 0,
      rejected_qty: Number(s.rejected_qty) || 0,
      rejected_boxes: Number(s.rejected_boxes) || 0,
      reason: s.reason != null ? String(s.reason).trim() : null,
      remarks: s.remarks != null ? String(s.remarks).trim() : null,
      approved: !!s.approved,
      approved_by: s.approved_by ?? null,
      approved_at: s.approved_at ?? null,
      created_by: s.created_by ?? null,
      created_at: s.created_at ?? null,
      is_deleted: !!s.is_deleted,
    })),
    hold_scan_mode: d.hold_scan_mode || QC_HOLD_SCAN_PARTIAL,
  });
}

/** Flatten JSON onto row for API / list (frontend unchanged). */
export function flattenHoldRow(row) {
  if (!row) return row;
  const d = parseHoldData(row.hold_data);
  const boxes = d.boxes;
  return {
    ...row,
    hold_type: d.hold_type,
    qty: d.qty,
    total_boxes: d.total_boxes || boxes.length,
    scanned_box_uids: boxes.length ? JSON.stringify(boxes) : null,
    scanned_box_uids_list: boxes,
    completed_qty: d.completed_qty,
    completed_boxes: d.completed_boxes,
    rejected_qty: d.rejected_qty,
    rejected_boxes: d.rejected_boxes,
    hold_scan_mode: d.hold_scan_mode,
  };
}

export function buildPendingHoldData({ boxes = [], qty = 0, hold_scan_mode = QC_HOLD_SCAN_PARTIAL } = {}) {
  const list = boxes.map((v) => String(v).trim()).filter(Boolean);
  const qtyNum = Number(qty) || 0;
  return serializeHoldData({
    hold_type: QC_HOLD_TYPE_PENDING,
    boxes: list,
    qty: qtyNum,
    total_boxes: list.length,
    completed_qty: 0,
    completed_boxes: 0,
    rejected_qty: 0,
    rejected_boxes: 0,
    submissions: [],
    hold_scan_mode: hold_scan_mode || QC_HOLD_SCAN_PARTIAL,
  });
}

export function buildHoldDataPatch(existingRaw, patch = {}) {
  const d = parseHoldData(existingRaw);
  const next = { ...d, ...patch };
  if (patch.boxes !== undefined) {
    next.boxes = patch.boxes.map((v) => String(v).trim()).filter(Boolean);
    next.total_boxes = next.boxes.length;
  }
  return serializeHoldData(next);
}

export function listSubmissions(holdDataRaw, { pendingOnly = false, approvedOnly = false } = {}) {
  const subs = parseHoldData(holdDataRaw).submissions || [];
  return subs.filter((s) => {
    if (s.is_deleted) return false;
    if (pendingOnly && s.approved) return false;
    if (approvedOnly && !s.approved) return false;
    return true;
  });
}

export function hasPendingSubmission(holdDataRaw) {
  return listSubmissions(holdDataRaw, { pendingOnly: true }).length > 0;
}

export function submissionToApi(sub, holdId) {
  if (!sub) return null;
  const boxUids = Array.isArray(sub.completed_box_uids) ? sub.completed_box_uids : [];
  return {
    submission_id: sub.submission_id,
    hold_id: holdId,
    submission_type: sub.submission_type,
    completed_box_uids: boxUids.length ? JSON.stringify(boxUids) : null,
    completed_qty: Number(sub.completed_qty) || 0,
    completed_boxes: Number(sub.completed_boxes) || 0,
    rejected_qty: Number(sub.rejected_qty) || 0,
    rejected_boxes: Number(sub.rejected_boxes) || 0,
    reason: sub.reason ?? null,
    remarks: sub.remarks ?? null,
    approved: !!sub.approved,
    approved_by: sub.approved_by ?? null,
    approved_at: sub.approved_at ?? null,
    created_by: sub.created_by ?? null,
    created_at: sub.created_at ?? null,
    is_deleted: !!sub.is_deleted,
  };
}

function nextSubmissionId(submissions = []) {
  let max = 0;
  for (const s of submissions) {
    const id = Number(s.submission_id) || 0;
    if (id > max) max = id;
  }
  return max + 1;
}

export function appendSubmission(holdDataRaw, submission, userId) {
  const d = parseHoldData(holdDataRaw);
  const boxUids = Array.isArray(submission.completed_box_uids)
    ? submission.completed_box_uids.map((v) => String(v).trim()).filter(Boolean)
    : [];

  const entry = {
    submission_id: nextSubmissionId(d.submissions),
    submission_type: String(submission.submission_type || "").trim(),
    completed_box_uids: boxUids,
    completed_qty: Number(submission.completed_qty) || 0,
    completed_boxes: Number(submission.completed_boxes) || 0,
    rejected_qty: Number(submission.rejected_qty) || 0,
    rejected_boxes: Number(submission.rejected_boxes) || 0,
    reason: submission.reason != null ? String(submission.reason).trim() : null,
    remarks: submission.remarks != null ? String(submission.remarks).trim() : null,
    approved: false,
    approved_by: null,
    approved_at: null,
    created_by: userId ?? null,
    created_at: new Date().toISOString(),
    is_deleted: false,
  };

  d.submissions = [...(d.submissions || []), entry];
  return { holdData: serializeHoldData(d), submission: entry };
}

export function findSubmissionById(holdDataRaw, submissionId) {
  const id = Number(submissionId);
  if (!id) return null;
  return parseHoldData(holdDataRaw).submissions.find((s) => Number(s.submission_id) === id) || null;
}

export function approveSubmissionInData(holdDataRaw, submissionId, approvedBy, patch = null) {
  const d = parseHoldData(holdDataRaw);
  let approved = null;
  d.submissions = (d.submissions || []).map((s) => {
    if (Number(s.submission_id) !== Number(submissionId) || s.approved) return s;
    const base = { ...s };
    if (patch && typeof patch === "object") {
      if (patch.completed_qty !== undefined) base.completed_qty = Number(patch.completed_qty) || 0;
      if (patch.completed_boxes !== undefined) base.completed_boxes = Number(patch.completed_boxes) || 0;
      if (patch.rejected_qty !== undefined) base.rejected_qty = Number(patch.rejected_qty) || 0;
      if (patch.rejected_boxes !== undefined) base.rejected_boxes = Number(patch.rejected_boxes) || 0;
      if (patch.reason !== undefined) {
        base.reason = patch.reason != null ? String(patch.reason).trim() : null;
      }
      if (patch.remarks !== undefined) {
        base.remarks = patch.remarks != null ? String(patch.remarks).trim() : null;
      }
    }
    approved = {
      ...base,
      approved: true,
      approved_by: approvedBy ?? null,
      approved_at: new Date().toISOString(),
    };
    return approved;
  });
  if (!approved) return null;
  return { holdData: serializeHoldData(d), submission: approved };
}

export function rollupHoldDataAfterApproval(holdDataRaw, submission) {
  const d = parseHoldData(holdDataRaw);
  d.completed_qty = (Number(d.completed_qty) || 0) + (Number(submission.completed_qty) || 0);
  d.completed_boxes = (Number(d.completed_boxes) || 0) + (Number(submission.completed_boxes) || 0);
  d.rejected_qty = (Number(d.rejected_qty) || 0) + (Number(submission.rejected_qty) || 0);
  d.rejected_boxes = (Number(d.rejected_boxes) || 0) + (Number(submission.rejected_boxes) || 0);
  return serializeHoldData(d);
}

export function patchSubmissionCompletedBoxes(holdDataRaw, submissionId, { boxUids = [], completedBoxes = 0 } = {}) {
  const d = parseHoldData(holdDataRaw);
  const sid = Number(submissionId);
  d.submissions = (d.submissions || []).map((s) => {
    if (Number(s.submission_id) !== sid) return s;
    return {
      ...s,
      completed_box_uids: (boxUids || []).map((v) => String(v).trim()).filter(Boolean),
      completed_boxes: Number(completedBoxes) || 0,
    };
  });
  return serializeHoldData(d);
}

/** Remove consumed source boxes from hold_data after partial QC approval. */
export function removeBoxesFromHoldData(holdDataRaw, boxUids = []) {
  const d = parseHoldData(holdDataRaw);
  const remove = new Set((boxUids || []).map((v) => String(v).trim()).filter(Boolean));
  if (!remove.size) return serializeHoldData(d);
  d.boxes = (d.boxes || []).filter((uid) => !remove.has(String(uid).trim()));
  d.total_boxes = d.boxes.length;
  return serializeHoldData(d);
}

/** After revert approve — hold has no linked source boxes. */
export function clearHoldBoxesFromHoldData(holdDataRaw) {
  const d = parseHoldData(holdDataRaw);
  d.boxes = [];
  d.total_boxes = 0;
  return serializeHoldData(d);
}

export function reservedCompletedBoxUids(holdDataRaw) {
  const used = new Set();
  for (const sub of parseHoldData(holdDataRaw).submissions) {
    if (sub.is_deleted) continue;
    const uids = Array.isArray(sub.completed_box_uids) ? sub.completed_box_uids : [];
    for (const uid of uids) {
      const v = String(uid || "").trim();
      if (v) used.add(v);
    }
  }
  return used;
}

export function deriveStatusFromHoldData(holdDataRaw) {
  const d = parseHoldData(holdDataRaw);
  const balanceQty = Math.max(0, d.qty - d.completed_qty - d.rejected_qty);
  if (balanceQty <= 0) return "complete";
  if (d.completed_qty > 0 || d.rejected_qty > 0) return "partial";
  return "pending";
}
