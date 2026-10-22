import { findCoils } from "../../coil/models/coil.model.js";
import { findMrnByUid, findMrnUidsByMrnNo } from "../../mrn/models/mrn.model.js";

function mrnNoFromUid(uid) {
  const match = String(uid || "").trim().match(/^(\d+)_/);
  return match ? match[1] : "";
}

function emptyResult(page, limit) {
  const lim = limit || 500;
  return {
    data: [],
    total: 0,
    page: Math.max(1, Number(page) || 1),
    limit: lim,
    totalPages: 0,
  };
}

/** Load active coils for a Minus adjustment (MRN Portal + SA Add for the selected MRN UID). */
export async function findActiveCoilsForMinus({ mrn_uid, mrn_no, item_code, item_dcode, search, page, limit }) {
  const listOpts = {
    search,
    page,
    limit: limit || 500,
    sortBy: "coil_index",
    order: "ASC",
  };

  const explicitUid = mrn_uid != null ? String(mrn_uid).trim() : "";
  let no = mrn_no != null ? String(mrn_no).trim() : "";

  if (explicitUid) {
    if (!no) no = mrnNoFromUid(explicitUid);
    const mrn = await findMrnByUid(explicitUid);
    const resolvedUid = mrn?.uid ? String(mrn.uid).trim() : explicitUid;
    return findCoils({
      filters: { status: "active", mrn_uid: resolvedUid },
      ...listOpts,
    });
  }

  const uids = new Set();
  if (no) {
    for (const uid of await findMrnUidsByMrnNo(no)) uids.add(uid);
  }

  const hasMrnScope = Boolean(no || uids.size);

  if (hasMrnScope) {
    const uidList = [...uids];
    const filters =
      uidList.length === 1
        ? { status: "active", mrn_uid: uidList[0] }
        : {
            status: "active",
            mrn_or_match: true,
            mrn_uid_list: uidList,
            ...(no ? { mrn_no: no } : {}),
          };
    return findCoils({ filters, ...listOpts });
  }

  if (item_code || item_dcode) {
    return findCoils({
      filters: {
        status: "active",
        ...(item_code ? { item_code: String(item_code).trim() } : {}),
        ...(item_dcode ? { item_dcode: Number(item_dcode) || undefined } : {}),
      },
      ...listOpts,
    });
  }

  return emptyResult(page, listOpts.limit);
}
