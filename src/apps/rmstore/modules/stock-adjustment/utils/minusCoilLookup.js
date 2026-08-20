import { findCoils } from "../../coil/models/coil.model.js";
import { findMrnByUid, findMrnUidsByMrnNo } from "../../mrn/models/mrn.model.js";

function mrnNoFromUid(uid) {
  const match = String(uid || "").trim().match(/^(\d+)_/);
  return match ? match[1] : "";
}

/** Load active coils for a Minus adjustment (MRN Portal + SA Add, same MRN). */
export async function findActiveCoilsForMinus({ mrn_uid, mrn_no, item_code, item_dcode, search, page, limit }) {
  const uids = new Set();
  let no = mrn_no != null ? String(mrn_no).trim() : "";

  if (mrn_uid) {
    const key = String(mrn_uid).trim();
    uids.add(key);
    if (!no) no = mrnNoFromUid(key);

    const mrn = await findMrnByUid(key);
    if (mrn?.uid) uids.add(String(mrn.uid).trim());
    if (mrn?.mrn_no != null) no = String(mrn.mrn_no).trim();
  }

  if (no) {
    for (const uid of await findMrnUidsByMrnNo(no)) uids.add(uid);
  }

  const listOpts = {
    search,
    page,
    limit: limit || 500,
    sortBy: "coil_index",
    order: "ASC",
  };

  const empty = {
    data: [],
    total: 0,
    page: Math.max(1, Number(page) || 1),
    limit: listOpts.limit,
    totalPages: 0,
  };

  if (!uids.size && !no) {
    if (!item_code && !item_dcode) return empty;
  } else {
    const result = await findCoils({
      filters: {
        status: "active",
        mrn_or_match: true,
        mrn_uid_list: [...uids],
        ...(no ? { mrn_no: no } : {}),
      },
      ...listOpts,
    });
    if (result.total) return result;
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

  return empty;
}
