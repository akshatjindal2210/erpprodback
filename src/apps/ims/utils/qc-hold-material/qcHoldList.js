/**
 * QC Hold list — enrich DB rows for API responses.
 *
 * Step 1: Item map (cached) + balance fields from hold_data JSON
 * Step 2: IMS party / item display fields (light enrichRowsWithIMS)
 */

import { enrichRowsWithIMS, getImsMapsSafe } from "../erp-api/imsLookup.js";
import { findBoxByUidOrNoUid } from "../../models/box.model.js";
import { attachQcHoldBalances, parseBoxUidList } from "./qcHoldBalances.js";
import { flattenHoldRow } from "./qcHoldData.js";

export async function enrichQcHoldListRows(rows = []) {
  const { itemMap } = await getImsMapsSafe();

  const base = rows.map((row) => {
    const itemDcode = row.item_dcode != null ? String(row.item_dcode) : "";
    const item = itemDcode ? itemMap.get(itemDcode) : null;
    const withBalances = attachQcHoldBalances(row);
    return {
      ...withBalances,
      item_code: item?.item_code ?? row.item_code ?? null,
      item_desc: item?.item_desc ?? row.item_desc ?? null,
    };
  });

  return enrichRowsWithIMS(base);
}

/** Resolve scanned box UIDs on a single hold row (detail view). */
export async function enrichHoldScannedBoxes(row) {
  const uids = parseBoxUidList(flattenHoldRow(row).scanned_box_uids);
  if (!uids.length) return [];

  const boxes = [];
  for (const uid of uids) {
    const box = await findBoxByUidOrNoUid(uid);
    boxes.push({
      box_no_uid: box?.box_no_uid ?? uid,
      box_uid: box?.box_uid ?? null,
      packing_number: box?.packing_number ?? row.packing_number ?? null,
      qty: Number(box?.qty) || 0,
      location_no: box?.location_no ?? null,
    });
  }
  return boxes;
}
