import { findBoxesByUids } from "../models/box.model.js";
import {
  customerLinesFromRemovedBoxPayload,
  parseRemovedBoxIdsJson,
} from "./minusRemovedBoxPayload.js";
import { groupMinusBoxRowsByCustomer } from "./boxCustomerOverride.js";

function ledgerNameForCode(ledgerMap, accCode) {
  if (!ledgerMap || accCode == null) return null;
  const s = String(accCode).trim();
  return ledgerMap.get(s) ?? ledgerMap.get(Number(s)) ?? null;
}

export { buildMinusRemovedBoxIdsJson } from "./minusRemovedBoxPayload.js";

/** Per-adjustment customer/qty lines for minus list + detail (one DB row, many customers). */
export async function buildMinusCustomerLinesByAdjustmentId(rows = [], ledgerMap) {
  const minusRows = (rows || []).filter((r) => r.entry_type === "minus");
  const uidSet = new Set();
  for (const row of minusRows) {
    for (const uid of parseRemovedBoxIdsJson(row.removed_box_ids)) {
      if (Number.isFinite(uid) && uid > 0) uidSet.add(uid);
    }
  }

  let boxByUid = new Map();
  if (uidSet.size) {
    const boxRows = await findBoxesByUids([...uidSet].map(String));
    boxByUid = new Map((boxRows || []).map((b) => [Number(b.box_uid), b]));
  }

  const out = new Map();
  for (const row of minusRows) {
    const adjId = row.adjustment_id;
    if (adjId == null) continue;
    const defaultPn = String(row.packing_number ?? "").trim();
    const fromPayload = customerLinesFromRemovedBoxPayload(
      row.removed_box_ids,
      defaultPn,
      ledgerMap
    );
    if (fromPayload?.length) {
      out.set(adjId, fromPayload);
      continue;
    }
    const uids = parseRemovedBoxIdsJson(row.removed_box_ids);
    const boxes = uids.map((uid) => boxByUid.get(uid)).filter(Boolean);
    const groups = groupMinusBoxRowsByCustomer(boxes);
    const lines = groups.map((g) => ({
      packing_number: g.packing_number || defaultPn || null,
      acc_code: g.acc_code,
      acc_name: ledgerNameForCode(ledgerMap, g.acc_code) ?? g.acc_code,
      qty: g.qty,
      box_count: g.box_count,
    }));
    out.set(adjId, lines);
  }
  return out;
}

export function applyMinusCustomerEnrichment(row, lines) {
  if (!Array.isArray(lines) || !lines.length) return row;
  const acc_name = lines
    .map((l) => l.acc_name || l.acc_code || "—")
    .join(", ");
  const acc_code =
    lines
      .map((l) => l.acc_code)
      .filter((c) => c != null && String(c).trim() !== "")
      .join(",") || null;
  return {
    ...row,
    minus_customer_lines: lines,
    acc_code,
    acc_name,
    party_rate_cust_code: lines.length === 1 ? row.party_rate_cust_code ?? null : null,
  };
}
