import { fetchFromIMS } from "../../../../ims/lib/services/ims.service.js";
import { mapErpMrnRecord } from "../controllers/mrn.controller.js";
import { findMrnByLookup, findMrnByUid, mrnSnapshotFromCoil } from "../models/mrn.model.js";
import { findCoilByUid, findCoils } from "../../coil/models/coil.model.js";

function matchErpMrnRecord(records, key) {
  const k = String(key || "").trim();
  if (!k) return null;
  const mapped = (records || []).map(mapErpMrnRecord).filter((r) => r?.uid);

  const byUid = mapped.find((r) => String(r.uid) === k);
  if (byUid) return byUid;

  const composite = k.match(/^(\d+)_(\d+)$/);
  if (composite) {
    const hit = mapped.find(
      (r) => String(r.mrn_no) === composite[1] && String(r.serial_no) === composite[2]
    );
    if (hit) return hit;
  }

  if (/^\d+$/.test(k)) {
    const hits = mapped.filter((r) => String(r.mrn_no) === k);
    if (hits.length === 1) return hits[0];
  }

  return null;
}

let erpMrnCache = { at: 0, records: [] };
const ERP_MRN_CACHE_MS = 30_000;

async function loadErpMrnRecords() {
  const now = Date.now();
  if (now - erpMrnCache.at < ERP_MRN_CACHE_MS && erpMrnCache.records.length) {
    return erpMrnCache.records;
  }
  const records = await fetchFromIMS("mrn_rm");
  erpMrnCache = { at: now, records: Array.isArray(records) ? records : [] };
  return erpMrnCache.records;
}

export async function fetchErpMrnByKey(key) {
  const records = await loadErpMrnRecords();
  return matchErpMrnRecord(records, key);
}

/**
 * Resolve MRN for sticker/detail flows:
 * - local uid / mrn_no / `{mrn_no}_{serial_no}`
 * - coil_no_uid (derive mrn_uid from coil)
 * - coils exist for uid but rmstore_mrn row is missing (synthetic snapshot from join)
 * - ERP mrn_rm row for pending MRNs not yet saved locally
 */
export async function resolveMrnForSticker(rawUid, { allowErp = false } = {}) {
  const key = String(rawUid || "").trim();
  if (!key) return { mrn_uid: null, mrn: null };

  let mrn = await findMrnByLookup(key);
  if (mrn) return { mrn_uid: String(mrn.uid), mrn };

  const coil = await findCoilByUid(key);
  if (coil?.mrn_uid) {
    const mrn_uid = String(coil.mrn_uid).trim();
    mrn = await findMrnByLookup(mrn_uid);
    if (mrn) return { mrn_uid: String(mrn.uid), mrn };
    return { mrn_uid, mrn: mrnSnapshotFromCoil(coil, mrn_uid) };
  }

  let coilLookup = await findCoils({
    filters: { mrn_uid: key },
    limit: 1,
    sortBy: "coil_index",
    order: "ASC",
  });
  let first = coilLookup.data?.[0];
  if (!first && /^\d+$/.test(key)) {
    coilLookup = await findCoils({
      filters: { mrn_no: key },
      limit: 1,
      sortBy: "coil_index",
      order: "ASC",
    });
    first = coilLookup.data?.[0];
  }
  if (first) {
    const mrn_uid = String(first.mrn_uid || key).trim();
    mrn = await findMrnByLookup(mrn_uid);
    if (mrn) return { mrn_uid: String(mrn.uid), mrn };
    return { mrn_uid, mrn: mrnSnapshotFromCoil(first, mrn_uid) };
  }

  if (allowErp) {
    const erp = await fetchErpMrnByKey(key);
    if (erp?.uid) {
      const mrn_uid = String(erp.uid).trim();
      const local = await findMrnByUid(mrn_uid);
      if (local) return { mrn_uid, mrn: local };
      return {
        mrn_uid,
        mrn: {
          ...erp,
          uid: mrn_uid,
          sticker_generated: false,
        },
      };
    }
  }

  return { mrn_uid: key, mrn: null };
}
