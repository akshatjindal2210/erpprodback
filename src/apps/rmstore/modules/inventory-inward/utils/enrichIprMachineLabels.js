import { findMacnamesForCoilUids, findMacnamesForJobCards } from "../../coil/models/coil.model.js";

function collectCoilUidsFromIpr(row) {
  const uids = new Set();
  for (const c of row?.coils || []) {
    const uid = String(c?.coil_no_uid || "").trim();
    if (uid) uids.add(uid);
  }
  for (const c of row?.previous_coils || []) {
    const uid = String(c?.coil_no_uid || "").trim();
    if (uid) uids.add(uid);
  }
  const seed = String(row?.seed_coil_uid || "").trim();
  if (seed) uids.add(seed);
  return uids;
}

function collectJobCardsFromIpr(row) {
  const jcs = new Set();
  const add = (v) => {
    const s = String(v || "").trim();
    if (s) jcs.add(s);
  };
  add(row?.pjobcardno);
  for (const c of row?.coils || []) add(c?.pjobcardno);
  for (const c of row?.previous_coils || []) add(c?.pjobcardno);
  return jcs;
}

function normalizeJcKey(jc) {
  return String(jc || "")
    .trim()
    .replace(/^JC[\s\-]*/i, "")
    .toUpperCase();
}

function coilMeta(macMap, coilUid) {
  if (!coilUid) return null;
  const hit = macMap.get(String(coilUid).trim());
  if (!hit) return null;
  return {
    pjobcardno: String(hit.pjobcardno || "").trim() || null,
    macname: String(hit.macname || "").trim() || null,
  };
}

/**
 * Display-only Job Card + Machine labels for IPR Register / Pending.
 * Fills empty fields from coil UID join (and machine from JC when JC exists).
 * Never overwrites non-empty saved values on working rows.
 */
export async function enrichIprWithMachineLabels(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;

  const allUids = new Set();
  const allJcs = new Set();
  for (const row of list) {
    for (const uid of collectCoilUidsFromIpr(row)) allUids.add(uid);
    for (const jc of collectJobCardsFromIpr(row)) allJcs.add(jc);
  }

  const [macMap, jcMacMap] = await Promise.all([
    allUids.size ? findMacnamesForCoilUids([...allUids]) : Promise.resolve(new Map()),
    allJcs.size ? findMacnamesForJobCards([...allJcs]) : Promise.resolve(new Map()),
  ]);

  return list.map((row) => {
    const macs = new Set();
    const jcs = new Set();

    const tagCoil = (c) => {
      if (!c) return c;
      const meta = coilMeta(macMap, c.coil_no_uid);
      const fromCoilMac = meta?.macname || null;
      const fromCoilJc = meta?.pjobcardno || null;
      const existingJc = String(c.pjobcardno || "").trim();
      const existingMac = String(c.macname || "").trim();
      const fromJcMac = jcMacMap.get(normalizeJcKey(existingJc || fromCoilJc));

      // Fill empty only — keep snapshotted values on working IPRs.
      const pjobcardno = existingJc || fromCoilJc || null;
      const macname = existingMac || fromCoilMac || fromJcMac || null;

      if (pjobcardno) jcs.add(pjobcardno);
      if (macname) macs.add(macname);

      if (pjobcardno === existingJc && macname === existingMac) return c;
      return {
        ...c,
        ...(pjobcardno && !existingJc ? { pjobcardno } : {}),
        ...(macname && !existingMac ? { macname } : {}),
      };
    };

    const coils = (row.coils || []).map(tagCoil);
    const previous_coils = (row.previous_coils || []).map(tagCoil);

    const savedCoilsHaveJc = (row.coils || []).some((c) => String(c?.pjobcardno || "").trim());
    const savedCoilsHaveMac = (row.coils || []).some((c) => String(c?.macname || "").trim());
    const rowJcFrozen = Boolean(String(row.pjobcardno || "").trim() || savedCoilsHaveJc);
    const rowMacFrozen = Boolean(String(row.macname || "").trim() || savedCoilsHaveMac);

    if (!rowJcFrozen || !rowMacFrozen) {
      for (const uid of collectCoilUidsFromIpr(row)) {
        const meta = coilMeta(macMap, uid);
        if (!rowMacFrozen && meta?.macname) macs.add(meta.macname);
        if (!rowJcFrozen && meta?.pjobcardno) jcs.add(meta.pjobcardno);
      }
    }
    for (const jc of collectJobCardsFromIpr(row)) {
      const m = jcMacMap.get(normalizeJcKey(jc));
      if (m) macs.add(m);
      if (jc) jcs.add(String(jc).trim());
    }

    const existingMac = String(row.macname || "").trim();
    const existingJc = String(row.pjobcardno || "").trim();
    if (existingMac) macs.add(existingMac);
    if (existingJc) jcs.add(existingJc);

    const targetKey = normalizeJcKey(
      row.reassign_jc && typeof row.reassign_jc === "object"
        ? row.reassign_jc.pjobcardno
        : row.reassign_jc
    );
    const isReassign = String(row.type || "").toLowerCase() === "reassign" && !!targetKey;

    // Reassign: Job Card column = SOURCE only (never the target reassign_jc).
    let pjobcardno = existingJc || null;
    let macname = existingMac || null;
    if (isReassign) {
      const candidates = [...jcs].filter((jc) => normalizeJcKey(jc) !== targetKey);
      if (!pjobcardno || normalizeJcKey(pjobcardno) === targetKey) {
        pjobcardno = candidates[0] || null;
      }
      // Don't invent source from live coil if it only resolves to target.
      if (pjobcardno && normalizeJcKey(pjobcardno) === targetKey) pjobcardno = null;
      if (!macname && pjobcardno) {
        macname = jcMacMap.get(normalizeJcKey(pjobcardno)) || [...macs].find(Boolean) || null;
      }
    } else {
      macname = existingMac || [...macs].join(" | ") || null;
      pjobcardno = existingJc || [...jcs].join(" | ") || null;
    }

    return { ...row, macname, pjobcardno, coils, previous_coils };
  });
}
