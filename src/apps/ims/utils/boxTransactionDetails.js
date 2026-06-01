/** @typedef {{ box_uid?: number, box_no_uid?: string, qty?: number, is_loose?: boolean | number | string, packing_number?: string }} BoxLogRow */

function isLooseRow(row) {
  return row?.is_loose === true || row?.is_loose === 1 || row?.is_loose === "true";
}

/**
 * Build consistent JSON `details` for ims_transaction_box (count, qty, standard vs loose, sticker ids).
 * @param {BoxLogRow[]} rows
 * @param {Record<string, unknown>} [extra]
 */
export function buildBoxLogDetails(rows = [], extra = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const seenUids = new Set();
  const box_sticker_entries = [];
  for (const r of list) {
    const uid = r?.box_no_uid != null ? String(r.box_no_uid).trim() : "";
    if (!uid || seenUids.has(uid)) continue;
    seenUids.add(uid);
    box_sticker_entries.push({ box_no_uid: uid, is_loose: isLooseRow(r) });
  }
  const box_no_uids = box_sticker_entries.map((e) => e.box_no_uid);
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
    box_sticker_entries,
    is_loose_flags: box_sticker_entries.map((e) => e.is_loose),
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

function splitUidTokens(value) {
  if (value == null || value === "") return [];
  return String(value)
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeBoxNoUidsField(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.flatMap((u) => splitUidTokens(u));
  return splitUidTokens(raw);
}

function isLooseFlag(flag) {
  return flag === true || flag === 1 || flag === "true";
}

function collectBoxNoUidsFromLogDetails(d, displayFallback = null) {
  const seen = new Set();
  const out = [];
  const add = (uid) => {
    const s = String(uid ?? "").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  if (Array.isArray(d.box_sticker_entries)) {
    for (const e of d.box_sticker_entries) add(e?.box_no_uid);
  }
  normalizeBoxNoUidsField(d.box_no_uids).forEach(add);
  add(d.box_no_uid);
  if (displayFallback) splitUidTokens(displayFallback).forEach(add);
  return out;
}

function boxIndexFromUid(uid) {
  const parts = String(uid ?? "")
    .trim()
    .split("_");
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mergeUidListsOrdered(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const uid of list) {
      const s = String(uid ?? "").trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function mergeLooseByUid(looseByUid, uid, isLoose) {
  if (!uid) return;
  if (!looseByUid.has(uid)) looseByUid.set(uid, isLoose);
  else if (isLoose) looseByUid.set(uid, true);
}

/** Map `is_loose_flags` to UIDs using `box_no_uids` array order (group / bulk logs). */
function applyFlagsToLooseMap(looseByUid, pnUids, flags) {
  if (!Array.isArray(flags) || !pnUids.length) return;
  pnUids.forEach((uid, i) => {
    if (flags[i] !== undefined) mergeLooseByUid(looseByUid, uid, isLooseFlag(flags[i]));
  });
}

function inferLooseAtIndex(i, total, d, looseByUid, uid, pnUids) {
  if (looseByUid.has(uid)) return looseByUid.get(uid);

  const flags = Array.isArray(d.is_loose_flags) ? d.is_loose_flags : [];
  const idxInPn = pnUids.indexOf(uid);
  if (idxInPn >= 0 && flags[idxInPn] !== undefined) return isLooseFlag(flags[idxInPn]);

  const kind = String(d.box_kind || "");
  if (kind === "Loose") return true;
  if (kind === "Standard") return false;

  const looseN = Number(d.loose_count) || 0;
  const stdN = Number(d.standard_count) || 0;
  const boxIdx = boxIndexFromUid(uid);

  if (looseN > 0 && stdN > 0) {
    const packTotal = Math.max(total, pnUids.length, boxIdx || 0);
    if (packTotal === looseN + stdN) {
      if (boxIdx != null) return boxIdx > stdN;
      return i >= stdN;
    }
  }
  if (looseN > 0 && total === looseN && stdN === 0) return true;
  return false;
}

/** All sticker UIDs + loose flags from stored log JSON (handles array, CSV string, legacy rows). */
export function buildBoxStickerEntriesFromLogDetails(detailsRaw, displayFallback = null) {
  const d = parseDetails(detailsRaw);
  const pnUids = normalizeBoxNoUidsField(d.box_no_uids);
  const flags = Array.isArray(d.is_loose_flags) ? d.is_loose_flags : [];

  const fromEntries = Array.isArray(d.box_sticker_entries)
    ? d.box_sticker_entries
        .map((e) => String(e?.box_no_uid ?? "").trim())
        .filter(Boolean)
    : [];

  const fromCollect = collectBoxNoUidsFromLogDetails(d, displayFallback);
  const fromDisplay = normalizeBoxNoUidsField(displayFallback);
  const uids = mergeUidListsOrdered(fromEntries, pnUids, fromCollect, fromDisplay);

  const looseByUid = new Map();
  if (Array.isArray(d.box_sticker_entries)) {
    for (const e of d.box_sticker_entries) {
      const uid = String(e?.box_no_uid ?? "").trim();
      if (uid) mergeLooseByUid(looseByUid, uid, isLooseRow(e));
    }
  }
  applyFlagsToLooseMap(looseByUid, pnUids, flags);

  return uids.map((uid, i) => ({
    box_no_uid: uid,
    is_loose: inferLooseAtIndex(i, uids.length, d, looseByUid, uid, pnUids),
  }));
}

export function mergeStickerEntriesByUid(existing = [], incoming = []) {
  const map = new Map();
  for (const e of [...existing, ...incoming]) {
    const uid = String(e?.box_no_uid ?? "").trim();
    if (!uid) continue;
    const loose = e?.is_loose === true || e?.is_loose === 1 || e?.is_loose === "true";
    if (!map.has(uid)) map.set(uid, { box_no_uid: uid, is_loose: loose });
    else if (loose) map.set(uid, { box_no_uid: uid, is_loose: true });
  }
  return [...map.values()];
}

/** Fill missing sticker UIDs for bulk logs that only stored `box_uids` in JSON. */
export async function hydrateTransactionBoxStickerEntries(row, findBoxesByUids) {
  const enriched = enrichTransactionBoxForList(row);
  const d = parseDetails(row?.details);
  const expected = Math.max(
    Number(enriched.box_count) || 0,
    Array.isArray(d.box_uids) ? d.box_uids.length : 0,
    normalizeBoxNoUidsField(d.box_no_uids).length
  );
  const have = enriched.box_sticker_entries?.length || 0;
  if (!expected || have >= expected || typeof findBoxesByUids !== "function") {
    return enriched;
  }

  const boxUids = (Array.isArray(d.box_uids) ? d.box_uids : [])
    .map((id) => Number(id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!boxUids.length) return enriched;

  const boxes = await findBoxesByUids(boxUids.map(String));
  const fromDb = (boxes || [])
    .filter((b) => b?.box_no_uid)
    .sort((a, b) => Number(a.box_uid) - Number(b.box_uid))
    .map((b) => ({
      box_no_uid: String(b.box_no_uid).trim(),
      is_loose: isLooseRow(b),
    }));

  if (!fromDb.length) return enriched;

  const merged = mergeStickerEntriesByUid(enriched.box_sticker_entries, fromDb);
  return {
    ...enriched,
    box_sticker_entries: merged,
    box_no_uids_display: merged.map((e) => e.box_no_uid).join(", "),
  };
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
  const stickerEntries = buildBoxStickerEntriesFromLogDetails(row?.details, row?.box_no_uids_display);
  const box_no_uids = stickerEntries.map((e) => e.box_no_uid);

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
    box_sticker_entries: stickerEntries,
    box_no_uids_display: box_no_uids.length ? box_no_uids.join(", ") : null,
  };
}
