import {
  findDailyProdByDocNo,
  findLatestApprovedStandardQtyForItem,
  findStandardQtyPerBoxForPackingNumber,
} from "../models/box.model.js";
import { normalizeBoxNoUidPrefix } from "../global/boxUid.js";

/*
 Stock adjustment (add): sticker-style box id.
  {string|number} packingNumber — doc / packing no
  {string|number} saToken — adjustment id, or "?" for preview before save
  {number} totalBoxes
  {number} boxIndex — 1-based
*/

/** Last numeric segment of `{packing}_SA{id}_{total}_{index}` (box index). */
export function parseStockAdjustmentBoxIndex(boxNoUid) {
  const parts = String(boxNoUid ?? "").trim().split("_");
  const last = parseInt(parts[parts.length - 1], 10);
  return Number.isFinite(last) && last > 0 ? last : 0;
}

export function formatStockAdjustmentBoxNoUid(packingNumber, saToken, totalBoxes, boxIndex, prefix = "") {
  const pn = String(packingNumber ?? "").trim();
  const tok = saToken === "?" || saToken === "preview" ? "?" : String(saToken);
  const tb = parseInt(String(totalBoxes), 10);
  const bi = parseInt(String(boxIndex), 10);
  if (!pn || !Number.isFinite(tb) || tb < 1 || !Number.isFinite(bi) || bi < 1) return "";
  const core = `${pn}_SA${tok}_${tb}_${bi}`;
  const pfx = normalizeBoxNoUidPrefix(prefix);
  return pfx ? `${pfx}_${core}` : core;
}

//  True when per-box qty is below packing standard (treat as loose).
export function isLooseBoxComparedToStandard(perBoxQty, standardQtyPerBox) {
  const p = parseInt(String(perBoxQty ?? ""), 10);
  const s = parseInt(String(standardQtyPerBox ?? ""), 10);
  return Number.isFinite(p) && p > 0 && Number.isFinite(s) && s > 0 && p < s;
}

// Standard pcs/box for UI or inserts: linked `dailyprod` standard first, else latest approved for item.
export async function resolveStandardQtyPerBoxForPacking({ packingNumber, itemDcode }) {
  const doc = packingNumber != null ? String(packingNumber).trim() : "";
  if (!doc) return null;
  const fromDoc = await findStandardQtyPerBoxForPackingNumber(doc);
  if (fromDoc != null) return fromDoc;
  return findLatestApprovedStandardQtyForItem(itemDcode);
}

/** Customer acc_code for sticker print / IMS (from dailyprod when available). */
export async function resolveOverrideCustForPacking(packingNumber) {
  const pn = String(packingNumber ?? "").trim();
  if (!pn) return null;
  const dp = await findDailyProdByDocNo(pn);
  if (dp?.acc_code != null && String(dp.acc_code).trim() !== "") {
    return String(dp.acc_code).trim();
  }
  return null;
}

// Rows for `insertBulkBoxes` / `insertBulkBoxesTx` after an add adjustment is inserted.
export function buildStockAdjustmentAddBoxInsertRows({
  packingNumber,
  adjustmentId,
  totalBoxes,
  perBoxQty,
  isLoose,
  userId,
  boxNoUidPrefix = "",
  override_cust = null,
}) {
  const pn = String(packingNumber ?? "").trim();
  const nb = parseInt(String(totalBoxes), 10);
  const qty = parseInt(String(perBoxQty), 10);
  const cust =
    override_cust != null && String(override_cust).trim() !== ""
      ? String(override_cust).trim()
      : null;
  const rows = [];
  for (let i = 1; i <= nb; i++) {
    rows.push({
      box_no_uid: formatStockAdjustmentBoxNoUid(pn, adjustmentId, nb, i, boxNoUidPrefix),
      packing_number: pn,
      qty,
      is_loose: !!isLoose,
      override_cust: cust,
      created_by: userId,
      sa_id: adjustmentId,
      sa_entry_type: "stock_in"
    });
  }
  return rows;
}

// Extra boxes on pending add edit (indices continue after existing).
export function buildStockAdjustmentAddExtraBoxRows({
  packingNumber,
  adjustmentId,
  totalBoxesAfter,
  startBoxIndex,
  extraCount,
  perBoxQty,
  isLoose,
  userId,
  boxNoUidPrefix = "",
  override_cust = null,
}) {
  const pn = String(packingNumber ?? "").trim();
  const extra = parseInt(String(extraCount), 10);
  const start = parseInt(String(startBoxIndex), 10);
  const total = parseInt(String(totalBoxesAfter), 10);
  const qty = parseInt(String(perBoxQty), 10);
  const cust =
    override_cust != null && String(override_cust).trim() !== ""
      ? String(override_cust).trim()
      : null;
  const rows = [];
  for (let i = 1; i <= extra; i++) {
    const boxIndex = start + i;
    rows.push({
      box_no_uid: formatStockAdjustmentBoxNoUid(pn, adjustmentId, total, boxIndex, boxNoUidPrefix),
      packing_number: pn,
      qty,
      is_loose: !!isLoose,
      override_cust: cust,
      created_by: userId,
      sa_id: adjustmentId,
      sa_entry_type: "stock_in"
    });
  }
  return rows;
}
