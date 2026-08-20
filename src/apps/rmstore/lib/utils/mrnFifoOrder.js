/** Unassigned / coil-area — IMS "loose" analogue. */
function isUnassignedCoil(c) {
  return c?.location_id == null || String(c?.location_no || "").toLowerCase() === "unassigned";
}

/** Packing # analogue: prefer mrn_uid, fall back to mrn_no. */
export function mrnGroupKey(c) {
  const uid = String(c?.mrn_uid || "").trim();
  if (uid) return uid;
  const no = c?.mrn_no;
  if (no != null && String(no).trim() !== "") return `no:${String(no).trim()}`;
  return "N/A";
}

/**
 * Same FIFO order as Issue Request modal (IMS packing style):
 * mrn_uid/mrn_no → stored before unassigned → created_at → coil_uid.
 */
export function sortCoilsFifo(coils = []) {
  return [...(coils || [])].sort((a, b) => {
    const keyA = mrnGroupKey(a);
    const keyB = mrnGroupKey(b);
    const rawNoA = a?.mrn_no != null && String(a.mrn_no).trim() !== "" ? Number(a.mrn_no) : NaN;
    const rawNoB = b?.mrn_no != null && String(b.mrn_no).trim() !== "" ? Number(b.mrn_no) : NaN;
    if (Number.isFinite(rawNoA) && Number.isFinite(rawNoB) && rawNoA !== rawNoB) return rawNoA - rawNoB;
    if (keyA !== keyB) return keyA.localeCompare(keyB, undefined, { numeric: true });

    const looseA = isUnassignedCoil(a) ? 1 : 0;
    const looseB = isUnassignedCoil(b) ? 1 : 0;
    if (looseA !== looseB) return looseA - looseB;

    const ta = a?.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b?.created_at ? new Date(b.created_at).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return Number(a?.coil_uid || 0) - Number(b?.coil_uid || 0);
  });
}

/** Order MRN quotas oldest-first (matches Issue Request FIFO). */
export function orderMrnQuotasFifo(quotas = [], poolCoils = []) {
  const byMrn = new Map(
    (quotas || []).map((q) => [String(q.mrn_uid || "").trim(), q]).filter(([k]) => k)
  );
  const ordered = [];
  const seen = new Set();
  for (const c of sortCoilsFifo(poolCoils || [])) {
    const k = mrnGroupKey(c);
    if (!k || k === "N/A" || seen.has(k)) continue;
    const q = byMrn.get(k);
    if (!q) continue;
    seen.add(k);
    ordered.push(q);
  }
  for (const q of quotas || []) {
    const k = String(q.mrn_uid || "").trim();
    if (k && !seen.has(k)) ordered.push(q);
  }
  return ordered;
}

/** MRN that may receive the next scan (FIFO). null = all quotas filled. */
export function nextAllowedMrnUid(orderedQuotas, scannedCoils) {
  const scannedByMrn = new Map();
  for (const c of scannedCoils || []) {
    const k = String(c?.mrn_uid || "").trim();
    if (k) scannedByMrn.set(k, (scannedByMrn.get(k) || 0) + 1);
  }
  for (const q of orderedQuotas || []) {
    const k = String(q.mrn_uid || "").trim();
    const need = Number(q.count) || 0;
    const got = scannedByMrn.get(k) || 0;
    if (got < need) return k;
  }
  return null;
}

/** Validate scan sequence respects MRN FIFO (oldest MRN quota before next). */
export function assertMrnScanFifoOrder(orderedQuotas, scannedCoilsInOrder) {
  const quotas = (orderedQuotas || []).map((q) => ({
    muid: String(q.mrn_uid || "").trim(),
    need: Number(q.count) || 0,
    mrn_no: q.mrn_no,
  }));
  const scannedByMrn = new Map();
  let activeIdx = 0;

  for (const coil of scannedCoilsInOrder || []) {
    const muid = String(coil?.mrn_uid || "").trim();
    const qIndex = quotas.findIndex((q) => q.muid === muid);
    if (qIndex < 0) {
      return {
        ok: false,
        message: `Coil ${coil?.coil_no_uid || ""} is not from a reserved MRN.`,
      };
    }
    if (qIndex > activeIdx) {
      const expected = quotas[activeIdx];
      return {
        ok: false,
        message: `MRN FIFO: complete MRN ${expected?.mrn_no || expected?.muid} before scanning MRN ${quotas[qIndex]?.mrn_no || muid}.`,
      };
    }
    scannedByMrn.set(muid, (scannedByMrn.get(muid) || 0) + 1);
    while (activeIdx < quotas.length) {
      const q = quotas[activeIdx];
      if ((scannedByMrn.get(q.muid) || 0) >= q.need) activeIdx += 1;
      else break;
    }
  }
  return { ok: true };
}
