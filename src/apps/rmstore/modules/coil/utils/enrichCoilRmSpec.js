import { findSpecItemDetail, findSpecItemDetailByItemCode, findSpecItemDetailByItemDesc } from "../../spec/models/specMaster.model.js";

/** RM Spec Master summary for Coil Finder (RM item vs authorized spec header). */
export async function enrichCoilRmSpec(row) {
  if (!row) return row;

  let detail = null;
  const dcode = Number(row.item_dcode);
  if (Number.isFinite(dcode) && dcode > 0) {
    detail = await findSpecItemDetail(dcode);
  }
  if (!detail && row.item_code) {
    detail = await findSpecItemDetailByItemCode(row.item_code);
  }
  if (!detail && row.item_desc) {
    detail = await findSpecItemDetailByItemDesc(row.item_desc);
  }

  if (!detail) {
    return { rm_spec_code: null, rm_spec_label: null };
  }

  const meta = [detail.condition, detail.grade, detail.size].filter(Boolean).join(" · ");
  const code = detail.item_code ? String(detail.item_code).trim() : null;
  const label = meta || (detail.item_desc ? String(detail.item_desc).trim() : null) || code;

  return { rm_spec_code: code, rm_spec_label: label || null };
}
