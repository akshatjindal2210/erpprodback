/** @typedef {{ box_uid?: number, box_no_uid?: string, qty?: number, is_loose?: boolean | number | string, packing_number?: string }} BoxLogRow */

function isLooseRow(row) {
  return row?.is_loose === true || row?.is_loose === 1 || row?.is_loose === "true";
}

/**
 * Build consistent JSON `details` for transaction_box (count, qty, standard vs loose, sticker ids).
 * @param {BoxLogRow[]} rows
 * @param {Record<string, unknown>} [extra]
 */
export function buildBoxLogDetails(rows = [], extra = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const box_no_uids = [
    ...new Set(
      list
        .map((r) => (r?.box_no_uid != null ? String(r.box_no_uid).trim() : ""))
        .filter(Boolean)
    ),
  ];
  const box_uids = list.map((r) => r?.box_uid).filter((u) => u != null);

  let standard_count = 0;
  let loose_count = 0;
  let total_qty = 0;
  const qtys = [];

  for (const r of list) {
    if (isLooseRow(r)) loose_count += 1;
    else standard_count += 1;
    const q = Number(r?.qty);
    if (Number.isFinite(q)) {
      total_qty += q;
      qtys.push(q);
    }
  }

  const count =
    extra.count != null && extra.count !== ""
      ? Number(extra.count) || 0
      : box_no_uids.length || list.length;

  let box_kind = extra.box_kind != null ? String(extra.box_kind) : null;
  if (!box_kind) {
    if (standard_count > 0 && loose_count > 0) box_kind = "Standard + Loose";
    else if (loose_count > 0) box_kind = "Loose";
    else if (standard_count > 0) box_kind = "Standard";
    else box_kind = null;
  }

  const per_box_qty =
    extra.per_box_qty != null
      ? Number(extra.per_box_qty)
      : qtys.length > 0 && new Set(qtys).size === 1
        ? qtys[0]
        : undefined;

  const resolvedQty =
    extra.total_qty != null && extra.total_qty !== ""
      ? Number(extra.total_qty)
      : extra.qty != null && extra.qty !== "" && !list.length
        ? Number(extra.qty)
        : total_qty > 0
          ? total_qty
          : per_box_qty != null && count > 0
            ? per_box_qty * count
            : null;

  const out = {
    ...extra,
    count,
    box_kind,
    standard_count,
    loose_count,
    total_qty: resolvedQty,
    box_no_uids,
    box_uids: box_uids.length ? box_uids : extra.box_uids,
  };

  if (per_box_qty != null && Number.isFinite(per_box_qty)) out.per_box_qty = per_box_qty;
  delete out.action;
  return out;
}

function parseDetails(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
}

function resolveBoxKind(d) {
  if (d.box_kind) return String(d.box_kind);
  const std = Number(d.standard_count) || 0;
  const loose = Number(d.loose_count) || 0;
  if (std > 0 && loose > 0) return "Standard + Loose";
  if (loose > 0) return "Loose";
  if (std > 0) return "Standard";
  const flags = Array.isArray(d.is_loose_flags) ? d.is_loose_flags : [];
  if (flags.length) {
    const hasLoose = flags.some((f) => f === true || f === 1 || f === "true");
    const hasStd = flags.some((f) => !(f === true || f === 1 || f === "true"));
    if (hasLoose && hasStd) return "Standard + Loose";
    if (hasLoose) return "Loose";
    if (hasStd) return "Standard";
  }
  return "—";
}

/** Add list-view fields from `details` JSON (works for older log rows too). */
export function enrichTransactionBoxForList(row) {
  const d = parseDetails(row?.details);
  const box_no_uids = Array.isArray(d.box_no_uids)
    ? d.box_no_uids.map((u) => String(u).trim()).filter(Boolean)
    : d.box_no_uid
      ? [String(d.box_no_uid).trim()]
      : [];

  const count =
    d.count != null && d.count !== ""
      ? Number(d.count)
      : box_no_uids.length || null;

  let total_qty = d.total_qty != null && d.total_qty !== "" ? Number(d.total_qty) : null;
  if ((total_qty == null || !Number.isFinite(total_qty)) && d.qty != null && d.qty !== "") {
    const q = Number(d.qty);
    const c = Number.isFinite(count) && count > 0 ? count : 1;
    total_qty = Number.isFinite(q) ? q * c : null;
  }
  if ((total_qty == null || !Number.isFinite(total_qty)) && d.per_box_qty != null && count > 0) {
    total_qty = Number(d.per_box_qty) * count;
  }

  return {
    ...row,
    box_count: Number.isFinite(count) ? count : null,
    total_qty: Number.isFinite(total_qty) ? total_qty : null,
    box_kind: resolveBoxKind(d),
    box_no_uids_display: box_no_uids.length ? box_no_uids.join(", ") : null,
  };
}
