import { groupMinusBoxRowsByCustomer } from "../box/boxCustomerOverride.js";

function ledgerNameForCode(ledgerMap, accCode) {
  if (!ledgerMap || accCode == null) return null;
  const s = String(accCode).trim();
  return ledgerMap.get(s) ?? ledgerMap.get(Number(s)) ?? null;
}

export function parseMinusRemovedBoxPayload(raw) {
  if (raw == null || raw === "") return { uids: [], customer_lines: null };
  if (Array.isArray(raw)) {
    const uids = raw.map((u) => Number(u)).filter((n) => Number.isFinite(n) && n > 0);
    return { uids: [...new Set(uids)], customer_lines: null };
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return { uids: [raw], customer_lines: null };
  }
  try {
    let parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    if (Array.isArray(parsed)) {
      const uids = parsed.map((u) => Number(u)).filter((n) => Number.isFinite(n) && n > 0);
      return { uids: [...new Set(uids)], customer_lines: null };
    }
    if (parsed && typeof parsed === "object") {
      const arr = parsed.uids ?? parsed.box_uids ?? parsed.removed_box_uids;
      const uids = (Array.isArray(arr) ? arr : [])
        .map((u) => Number(u))
        .filter((n) => Number.isFinite(n) && n > 0);
      const customer_lines = Array.isArray(parsed.customer_lines)
        ? parsed.customer_lines
        : null;
      return { uids: [...new Set(uids)], customer_lines };
    }
  } catch {
    /* fall through */
  }
  return { uids: [], customer_lines: null };
}

export function parseRemovedBoxIdsJson(raw) {
  return parseMinusRemovedBoxPayload(raw).uids;
}

/** Persist minus boxes + per-customer snapshot in one DB row (flow unchanged). */
export function buildMinusRemovedBoxIdsJson(boxRows, packingNumber, ledgerMap) {
  const uids = (boxRows || [])
    .map((b) => Number(b.box_uid))
    .filter((n) => Number.isFinite(n) && n > 0);
  const defaultPn = String(packingNumber ?? "").trim();
  const groups = groupMinusBoxRowsByCustomer(boxRows);
  const customer_lines = groups.map((g) => ({
    packing_number: g.packing_number || defaultPn || null,
    acc_code: g.acc_code,
    acc_name: ledgerNameForCode(ledgerMap, g.acc_code) ?? g.acc_code,
    qty: g.qty,
    box_count: g.box_count,
  }));
  if (!uids.length) return JSON.stringify([]);
  // Always persist customer snapshot (even single customer) for accurate view/approve.
  return JSON.stringify({ uids, customer_lines });
}

export function normalizeStoredMinusCustomerLines(lines, defaultPn, ledgerMap) {
  if (!Array.isArray(lines) || !lines.length) return null;
  return lines.map((l) => ({
    packing_number: l.packing_number || defaultPn || null,
    acc_code: l.acc_code ?? null,
    acc_name:
      (l.acc_name != null && String(l.acc_name).trim() !== ""
        ? String(l.acc_name).trim()
        : null) ??
      ledgerNameForCode(ledgerMap, l.acc_code) ??
      l.acc_code,
    qty: Math.abs(parseInt(l.qty, 10) || 0),
    box_count: parseInt(l.box_count, 10) || 0,
  }));
}

export function customerLinesFromRemovedBoxPayload(raw, defaultPn, ledgerMap) {
  const payload = parseMinusRemovedBoxPayload(raw);
  return normalizeStoredMinusCustomerLines(payload.customer_lines, defaultPn, ledgerMap);
}
