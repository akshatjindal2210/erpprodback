import { getImsMapsSafe } from "../../../../lib/utils/erp-api/lookup/imsLookup.js";
import { listSubmissions, parseHoldData } from "./qcHoldData.js";

function t(v) {
  const n = v ? new Date(v).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
}

function inRange(at, from, to) {
  const x = t(at);
  if (!x) return !from && !to;
  if (from && x < t(from)) return false;
  if (to && x > t(to)) return false;
  return true;
}

function event(label, info = {}) {
  return { info: { Event: label, ...info } };
}

export function expandHoldToTransactionRows(hold, itemCode = null) {
  if (!hold?.hold_id) return [];
  const d = parseHoldData(hold.hold_data);
  const qty = Number(d.qty) || 0;
  const base = {
    entity_id: String(hold.hold_id),
    packing_number: hold.packing_number || null,
    item_dcode: hold.item_dcode ?? null,
    item_code: itemCode || hold.item_code || (hold.item_dcode != null ? String(hold.item_dcode) : null),
    qty: qty || null,
    created_by_name: hold.created_by || null,
    hold_created_at: hold.created_at || null,
    updated_by_name: null,
    hold_updated_at: null,
    approved_by_name: null,
    hold_approved_at: null,
  };
  const rows = [
    {
      ...base,
      id: `qch-${hold.hold_id}-create`,
      action_type: "CREATE",
      user_name: hold.created_by || null,
      created_at: hold.created_at || null,
      description: hold.reason || hold.remarks || "Put on hold",
      log_data: event("Put on hold", { Qty: qty || undefined, Reason: hold.reason || undefined }),
    },
  ];

  for (const sub of listSubmissions(hold.hold_data)) {
    const sid = Number(sub.submission_id) || 0;
    const done = (Number(sub.completed_qty) || 0) + (Number(sub.rejected_qty) || 0);
    const revert = String(sub.submission_type || "").toLowerCase() === "revert";
    const subQty = done > 0 ? done : qty || null;
    const submitLabel = revert ? "Release requested" : "Submitted — awaiting approval";

    rows.push({
      ...base,
      id: `qch-${hold.hold_id}-submit-${sid || t(sub.created_at)}`,
      action_type: "SUBMIT",
      user_name: sub.created_by || null,
      created_at: sub.created_at || null,
      description: sub.reason || sub.remarks || submitLabel,
      qty: subQty,
      updated_by_name: sub.created_by || null,
      hold_updated_at: sub.created_at || null,
      log_data: event(submitLabel, {
        "Completed qty": Number(sub.completed_qty) || undefined,
        "Rejected qty": Number(sub.rejected_qty) || undefined,
      }),
    });

    if (!sub.approved) continue;
    const complete =
      String(hold.status || "").toLowerCase() === "complete" ||
      Math.max(0, qty - (Number(d.completed_qty) || 0) - (Number(d.rejected_qty) || 0)) <= 0;
    const label = revert ? "Released" : complete ? "Passed" : "Partial progress approved";

    rows.push({
      ...base,
      id: `qch-${hold.hold_id}-approve-${sid || t(sub.approved_at)}`,
      action_type: "APPROVE",
      user_name: sub.approved_by || null,
      created_at: sub.approved_at || null,
      description: sub.reason || sub.remarks || label,
      qty: subQty,
      approved_by_name: sub.approved_by || null,
      hold_approved_at: sub.approved_at || null,
      log_data: event(label, {
        "Completed qty": Number(sub.completed_qty) || undefined,
        "Rejected qty": Number(sub.rejected_qty) || undefined,
      }),
    });
  }

  if (hold.is_deleted) {
    rows.push({
      ...base,
      id: `qch-${hold.hold_id}-delete`,
      action_type: "DELETE",
      user_name: hold.deleted_by || null,
      created_at: hold.deleted_at || hold.updated_at || null,
      description: "Hold deleted",
      updated_by_name: hold.deleted_by || null,
      hold_updated_at: hold.deleted_at || null,
      log_data: event("Hold deleted"),
    });
  }

  return rows;
}

export async function buildQcHoldTransactionLog({
  holds = [],
  fromDate,
  toDate,
  search,
  page = 1,
  limit = 1000,
} = {}) {
  const { itemMap } = await getImsMapsSafe();
  let rows = [];
  for (const hold of holds || []) {
    const dcode = hold.item_dcode != null ? String(hold.item_dcode) : "";
    const item = dcode ? itemMap.get(dcode) : null;
    rows.push(...expandHoldToTransactionRows(hold, item?.item_code ?? hold.item_code ?? (dcode || null)));
  }

  if (fromDate || toDate) rows = rows.filter((r) => inRange(r.created_at, fromDate, toDate));
  const q = String(search || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      [r.entity_id, r.packing_number, r.item_code, r.action_type, r.description, r.user_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }

  rows.sort((a, b) => t(b.created_at) - t(a.created_at));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit, 10) || 1000));
  const start = (safePage - 1) * safeLimit;
  return { data: rows.slice(start, start + safeLimit), total: rows.length };
}
