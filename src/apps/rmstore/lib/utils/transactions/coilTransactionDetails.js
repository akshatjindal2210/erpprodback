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

function normalizeCoilNoUidsField(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.flatMap((u) => splitUidTokens(u));
  return splitUidTokens(raw);
}

function buildCoilStickerEntriesFromLogDetails(detailsRaw) {
  const d = parseDetails(detailsRaw);
  const map = new Map();

  const push = (uid, qty) => {
    const key = String(uid ?? "").trim();
    if (!key) return;
    const prev = map.get(key) || { coil_no_uid: key };
    if (Number.isFinite(Number(qty))) prev.qty = Number(qty);
    map.set(key, prev);
  };

  if (Array.isArray(d.coil_sticker_entries)) {
    for (const e of d.coil_sticker_entries) {
      push(e?.coil_no_uid, e?.qty);
    }
  }

  for (const uid of normalizeCoilNoUidsField(d.coil_no_uids)) {
    push(uid, null);
  }
  if (d.coil_no_uid) push(d.coil_no_uid, d.qty ?? d.per_coil_qty);

  return [...map.values()];
}

export function enrichCoilTransactionForList(row) {
  const d = parseDetails(row?.details);
  const stickerEntries = buildCoilStickerEntriesFromLogDetails(row?.details);
  const coil_no_uids = stickerEntries.map((e) => e.coil_no_uid);

  const count =
    d.coil_count != null && d.coil_count !== ""
      ? Number(d.coil_count)
      : d.count != null && d.count !== ""
        ? Number(d.count)
        : coil_no_uids.length || null;

  let total_qty = d.total_qty != null && d.total_qty !== "" ? Number(d.total_qty) : null;
  if ((total_qty == null || !Number.isFinite(total_qty)) && d.qty != null && d.qty !== "") {
    const q = Number(d.qty);
    total_qty = Number.isFinite(q) ? q : null;
  }
  if ((total_qty == null || !Number.isFinite(total_qty)) && stickerEntries.some((e) => Number.isFinite(Number(e.qty)))) {
    total_qty = stickerEntries.reduce((s, e) => s + (Number(e.qty) || 0), 0);
  }

  return {
    ...row,
    coil_count: Number.isFinite(count) ? count : null,
    total_qty: Number.isFinite(total_qty) ? total_qty : null,
    coil_sticker_entries: stickerEntries,
    coil_no_uids_display: coil_no_uids.length ? coil_no_uids.join(", ") : null,
  };
}

export async function hydrateCoilTransactionStickerEntries(row, findCoilsByUids) {
  const enriched = enrichCoilTransactionForList(row);
  const d = parseDetails(row?.details);
  if (typeof findCoilsByUids !== "function") return enriched;

  const uids = normalizeCoilNoUidsField(d.coil_no_uids);
  if (d.coil_no_uid) uids.push(String(d.coil_no_uid).trim());
  const uniqueUids = [...new Set(uids.filter(Boolean))];
  if (!uniqueUids.length) return enriched;

  const needsQtyFill = (enriched.coil_sticker_entries || []).some(
    (e) => !Number.isFinite(Number(e?.qty))
  );
  const have = enriched.coil_sticker_entries?.length || 0;
  if (have >= uniqueUids.length && !needsQtyFill) return enriched;

  const coils = await findCoilsByUids(uniqueUids);
  const fromDb = (coils || [])
    .filter((c) => c?.coil_no_uid)
    .map((c) => ({
      coil_no_uid: String(c.coil_no_uid).trim(),
      qty: Number.isFinite(Number(c.qty)) ? Number(c.qty) : undefined,
    }));

  if (!fromDb.length) return enriched;

  const map = new Map();
  for (const e of enriched.coil_sticker_entries || []) {
    map.set(e.coil_no_uid, { ...e });
  }
  for (const e of fromDb) {
    const prev = map.get(e.coil_no_uid) || { coil_no_uid: e.coil_no_uid };
    if (Number.isFinite(Number(e.qty)) && !Number.isFinite(Number(prev.qty))) {
      prev.qty = Number(e.qty);
    }
    map.set(e.coil_no_uid, prev);
  }

  const merged = [...map.values()];
  let total_qty = enriched.total_qty;
  if (merged.some((e) => Number.isFinite(Number(e.qty)))) {
    total_qty = merged.reduce((s, e) => s + (Number(e.qty) || 0), 0);
  }

  return {
    ...enriched,
    coil_sticker_entries: merged,
    coil_no_uids_display: merged.map((e) => e.coil_no_uid).join(", "),
    coil_count: merged.length || enriched.coil_count,
    total_qty: Number.isFinite(total_qty) ? total_qty : enriched.total_qty,
  };
}
