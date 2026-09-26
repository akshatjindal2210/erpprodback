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

/** Display-only machine names (coil join, else IR job-card macname). */
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
    const tagCoil = (c) => {
      if (!c) return c;
      const fromCoil = c.coil_no_uid ? macMap.get(String(c.coil_no_uid).trim()) : null;
      const fromJc = jcMacMap.get(normalizeJcKey(c.pjobcardno));
      const m = fromCoil || fromJc || String(c.macname || "").trim() || null;
      if (m) macs.add(m);
      if (!m || m === String(c.macname || "").trim()) return c;
      return { ...c, macname: m };
    };
    const coils = (row.coils || []).map(tagCoil);
    const previous_coils = (row.previous_coils || []).map(tagCoil);
    for (const uid of collectCoilUidsFromIpr(row)) {
      const m = macMap.get(uid);
      if (m) macs.add(m);
    }
    for (const jc of collectJobCardsFromIpr(row)) {
      const m = jcMacMap.get(normalizeJcKey(jc));
      if (m) macs.add(m);
    }
    const existing = String(row.macname || "").trim();
    if (existing) macs.add(existing);
    const macname = [...macs].join(" | ") || null;
    return { ...row, macname, coils, previous_coils };
  });
}
