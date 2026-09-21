import { findMacnamesForCoilUids } from "../../coil/models/coil.model.js";

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

/** Display-only machine names for pending store-in (from issue-request job card). */
export async function enrichIprWithMachineLabels(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;

  const allUids = new Set();
  for (const row of list) {
    for (const uid of collectCoilUidsFromIpr(row)) allUids.add(uid);
  }
  if (!allUids.size) return list;

  const macMap = await findMacnamesForCoilUids([...allUids]);

  return list.map((row) => {
    const macs = new Set();
    const tagCoil = (c) => {
      if (!c?.coil_no_uid) return c;
      const m = macMap.get(String(c.coil_no_uid).trim());
      if (m) macs.add(m);
      return m ? { ...c, macname: m } : c;
    };
    const coils = (row.coils || []).map(tagCoil);
    const previous_coils = (row.previous_coils || []).map(tagCoil);
    for (const uid of collectCoilUidsFromIpr(row)) {
      const m = macMap.get(uid);
      if (m) macs.add(m);
    }
    const macname = [...macs].join(" | ") || null;
    return { ...row, macname, coils, previous_coils };
  });
}
