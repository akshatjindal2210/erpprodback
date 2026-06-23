/** Flat dailyprod sticker fields at generate time — stored in table columns (no JSON snapshot). */
import { normalizeDocDtForDb } from "./packRowParse.js";

function trimOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" || s === "—" ? null : s;
}

export function buildDailyProdStickerFields(body = {}) {
  const packing_config = body.packing_config && typeof body.packing_config === "object" ? body.packing_config : {};
  const pc = packing_config;

  const categoryId = body.category_id ?? body.type ?? pc.type ?? null;
  let categoryName = body.category_name ?? body.category ?? body.ims_category ?? null;
  if (
    categoryName != null &&
    categoryId != null &&
    String(categoryName).trim() === String(categoryId).trim()
  ) {
    categoryName = null;
  }

  return {
    acc_code: body.acc_code ?? null,
    acc_name: body.acc_name ?? null,
    party_rate_cust_code: body.party_rate_cust_code ?? null,
    itemdcode: body.itemdcode ?? null,
    item_code: body.item_code ?? null,
    item_desc: trimOrNull(body.itemdesc ?? body.description ?? body.item_desc),
    doc_dt: normalizeDocDtForDb(body.doc_dt),
    job_card_no: body.job_card_no ?? null,
    total_qty: body.total_qty ?? null,
    unit: body.unit ?? pc.unit ?? "PCS",
    fg_location: body.fg_location ?? null,
    category_id: categoryId,
    category_name: categoryName,
    packing_standard_id: pc.standard_id ?? body.packing_standard_id ?? null,
    qty_per_box: pc.qty_per_box ?? null,
    full_boxes_count: pc.full_boxes_count ?? null,
    loose_box_qty: pc.loose_box_qty ?? null,
    total_stickers: pc.total_stickers ?? null,
  };
}

/** SQL fragment — extra sticker columns on ims_dailyprod (for SELECT lists). */
export const DAILYPROD_STICKER_EXTRA_SELECT = `
  item_desc,
  party_rate_cust_code,
  unit,
  fg_location,
  category_id,
  category_name,
  qty_per_box,
  full_boxes_count,
  loose_box_qty,
  total_stickers,
  packing_standard_id
`;

/** Core production fields from ims_dailyprod row (comparison / local_source). */
export function dailyProdSnapshotCoreFields(dpRow) {
  if (!dpRow) return {};
  return {
    doc_dt: normalizeDocDtForDb(dpRow.doc_dt),
    job_card_no: dpRow.job_card_no ?? null,
    total_qty:
      dpRow.total_qty != null && String(dpRow.total_qty).trim() !== ""
        ? String(dpRow.total_qty)
        : null,
    acc_code: dpRow.acc_code ?? null,
    acc_name: dpRow.acc_name ?? null,
    itemdcode: dpRow.itemdcode ?? dpRow.item_dcode ?? null,
    item_code: dpRow.item_code ?? null,
  };
}

/** Flat list/view fields from ims_dailyprod row (packing entry table + detail modal). */
export function dailyProdListFieldsFromRow(dpRow) {
  if (!dpRow) return {};
  const categoryId = dpRow.category_id ?? null;
  let categoryName = dpRow.category_name ?? null;
  if (
    categoryName != null &&
    categoryId != null &&
    String(categoryName).trim() === String(categoryId).trim()
  ) {
    categoryName = null;
  }
  return {
    packing_category: categoryName || null,
    packing_category_id: categoryId,
    qty_per_box: dpRow.qty_per_box ?? null,
    full_boxes_count: dpRow.full_boxes_count ?? null,
    loose_box_qty: dpRow.loose_box_qty ?? null,
    total_stickers: dpRow.total_stickers ?? null,
    party_rate_cust_code: dpRow.party_rate_cust_code ?? null,
    sticker_unit: dpRow.unit ?? "PCS",
    fg_location: dpRow.fg_location ?? null,
  };
}

/** Read customer name frozen at sticker generate — no live IMS lookup. */
export function storedPackingCustomerName(dpRow) {
  const name = dpRow?.acc_name ?? null;
  if (name == null || String(name).trim() === "") return null;
  return String(name).trim();
}

/** Map ims_dailyprod row → sticker fetch API row shape. */
export function stickerFetchRowFromDailyProd(dpRow) {
  if (!dpRow) return null;

  const docNo = dpRow?.doc_no ?? null;
  const categoryName = dpRow.category_name ?? null;

  return {
    doc_no: docNo,
    doc_dt: normalizeDocDtForDb(dpRow.doc_dt),
    job_card_no: dpRow.job_card_no ?? null,
    itemdcode: dpRow.itemdcode ?? dpRow.item_dcode ?? null,
    item_code: dpRow.item_code ?? null,
    itemdesc: dpRow.item_desc ?? null,
    item_desc: dpRow.item_desc ?? null,
    total_qty: dpRow.total_qty ?? null,
    acc_code: dpRow.acc_code ?? null,
    acc_name: dpRow.acc_name ?? null,
    party_rate_cust_code: dpRow.party_rate_cust_code ?? null,
    sticker_generated: true,
    standard_id: dpRow.packing_standard_id ?? null,
    standard_qty_per_box: dpRow.qty_per_box ?? null,
    unit: dpRow.unit ?? "PCS",
    type: dpRow.category_id ?? null,
    ims_category: categoryName,
    category: categoryName,
    fg_location: dpRow.fg_location ?? null,
    packing_details: {
      package_num: docNo,
      standard_id: dpRow.packing_standard_id ?? null,
      total_qty: dpRow.total_qty ?? null,
      qty_per_box: dpRow.qty_per_box ?? null,
      full_boxes_count: dpRow.full_boxes_count ?? null,
      loose_box_qty: dpRow.loose_box_qty ?? null,
      total_stickers: dpRow.total_stickers ?? null,
    },
  };
}
