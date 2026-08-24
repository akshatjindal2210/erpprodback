/**
 * Stock Adjustment "Update" — qty change on one existing box.
 * Stored in `ims_stock_adjustment.removed_box_ids` as JSON (same column as minus plan).
 */

export function parseQtyUpdatePayload(raw) {
  if (raw == null || raw === "") return null;
  try {
    let parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (String(parsed.kind ?? "").trim() !== "qty_update") return null;

    const box_uid = Number(parsed.box_uid);
    if (!Number.isFinite(box_uid) || box_uid < 1) return null;

    const update_action = String(parsed.update_action ?? "").trim().toLowerCase();
    if (update_action !== "add" && update_action !== "minus") return null;

    const update_qty = parseInt(String(parsed.update_qty ?? ""), 10);
    if (!Number.isFinite(update_qty) || update_qty < 1) return null;

    const snapshot_qty = parseInt(String(parsed.snapshot_qty ?? ""), 10);
    const applied_delta =
      parsed.applied_delta != null && parsed.applied_delta !== ""
        ? parseInt(String(parsed.applied_delta), 10)
        : null;
    const applied_from_qty =
      parsed.applied_from_qty != null && parsed.applied_from_qty !== ""
        ? parseInt(String(parsed.applied_from_qty), 10)
        : null;
    const applied_to_qty =
      parsed.applied_to_qty != null && parsed.applied_to_qty !== ""
        ? parseInt(String(parsed.applied_to_qty), 10)
        : null;

    return {
      kind: "qty_update",
      box_uid,
      box_no_uid:
        parsed.box_no_uid != null && String(parsed.box_no_uid).trim() !== ""
          ? String(parsed.box_no_uid).trim()
          : null,
      packing_number:
        parsed.packing_number != null && String(parsed.packing_number).trim() !== ""
          ? String(parsed.packing_number).trim()
          : null,
      snapshot_qty: Number.isFinite(snapshot_qty) ? snapshot_qty : null,
      update_action,
      update_qty,
      applied_delta: Number.isFinite(applied_delta) ? applied_delta : null,
      applied_from_qty: Number.isFinite(applied_from_qty) ? applied_from_qty : null,
      applied_to_qty: Number.isFinite(applied_to_qty) ? applied_to_qty : null,
    };
  } catch {
    return null;
  }
}

export function buildQtyUpdatePayload({
  box_uid,
  box_no_uid = null,
  packing_number = null,
  snapshot_qty,
  update_action,
  update_qty,
  applied_delta = null,
  applied_from_qty = null,
  applied_to_qty = null,
}) {
  const uid = Number(box_uid);
  const action = String(update_action ?? "").trim().toLowerCase();
  const qty = parseInt(String(update_qty ?? ""), 10);
  const snap = parseInt(String(snapshot_qty ?? ""), 10);

  if (!Number.isFinite(uid) || uid < 1) {
    const err = new Error("Valid box required for qty update.");
    err.statusCode = 400;
    throw err;
  }
  if (action !== "add" && action !== "minus") {
    const err = new Error('Update action must be "add" or "minus".');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(qty) || qty < 1) {
    const err = new Error("Update quantity must be a positive integer.");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(snap) || snap < 0) {
    const err = new Error("Current box quantity is invalid.");
    err.statusCode = 400;
    throw err;
  }
  if (action === "minus" && snap - qty < 0) {
    const err = new Error(
      `Minus would make qty negative (current ${snap}, minus ${qty}).`
    );
    err.statusCode = 400;
    throw err;
  }

  const signedDelta = action === "add" ? qty : -qty;

  return {
    json: JSON.stringify({
      kind: "qty_update",
      box_uid: uid,
      box_no_uid:
        box_no_uid != null && String(box_no_uid).trim() !== ""
          ? String(box_no_uid).trim()
          : null,
      packing_number:
        packing_number != null && String(packing_number).trim() !== ""
          ? String(packing_number).trim()
          : null,
      snapshot_qty: snap,
      update_action: action,
      update_qty: qty,
      applied_delta:
        applied_delta != null && Number.isFinite(Number(applied_delta))
          ? Number(applied_delta)
          : null,
      applied_from_qty:
        applied_from_qty != null && Number.isFinite(Number(applied_from_qty))
          ? Number(applied_from_qty)
          : null,
      applied_to_qty:
        applied_to_qty != null && Number.isFinite(Number(applied_to_qty))
          ? Number(applied_to_qty)
          : null,
    }),
    signedDelta,
    snapshot_qty: snap,
    update_action: action,
    update_qty: qty,
    box_uid: uid,
  };
}

export function computeQtyUpdateResult(liveQty, update_action, update_qty) {
  const live = parseInt(String(liveQty ?? ""), 10);
  const qty = parseInt(String(update_qty ?? ""), 10);
  const action = String(update_action ?? "").trim().toLowerCase();
  if (!Number.isFinite(live) || live < 0) {
    const err = new Error("Live box quantity is invalid.");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(qty) || qty < 1) {
    const err = new Error("Update quantity must be a positive integer.");
    err.statusCode = 400;
    throw err;
  }
  const next = action === "add" ? live + qty : live - qty;
  if (next < 0) {
    const err = new Error(
      `Minus would make qty negative (current ${live}, minus ${qty}).`
    );
    err.statusCode = 400;
    throw err;
  }
  return { from: live, to: next, delta: next - live };
}
