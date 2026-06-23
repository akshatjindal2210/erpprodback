/** Packing display fields for ims_stock_adjustment — stored in table columns only. */
import { normalizeDocDtForDb } from "../packing-entry/packRowParse.js";

function trimOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" || s === "—" ? null : s;
}

/** Map resolved packing meta → ims_stock_adjustment columns. */
export function packingMetaToSaDbFields(meta, { existing = null } = {}) {
  if (!meta) return {};

  const fields = {};
  const dt = normalizeDocDtForDb(meta.doc_dt);
  if (dt && !existing?.doc_dt) fields.doc_dt = dt;

  const jc = trimOrNull(meta.job_card_no);
  if (jc && !trimOrNull(existing?.job_card_no)) fields.job_card_no = jc;

  const acc = trimOrNull(meta.acc_code);
  if (acc && !trimOrNull(existing?.acc_code)) fields.acc_code = acc;

  const itemCode = trimOrNull(meta.item_code);
  if (itemCode && !trimOrNull(existing?.item_code)) fields.item_code = itemCode;

  const itemDesc = trimOrNull(meta.item_desc ?? meta.itemdesc);
  if (itemDesc && !trimOrNull(existing?.item_desc)) fields.item_desc = itemDesc;

  const accName = trimOrNull(meta.acc_name);
  if (accName && !trimOrNull(existing?.acc_name)) fields.acc_name = accName;

  return fields;
}

export function mergeAdjustmentPackingMeta(imsMeta, localMeta) {
  if (!imsMeta && !localMeta) return null;
  return {
    doc_dt: imsMeta?.doc_dt ?? localMeta?.doc_dt ?? null,
    job_card_no: imsMeta?.job_card_no ?? localMeta?.job_card_no ?? null,
    acc_code: imsMeta?.acc_code ?? localMeta?.acc_code ?? null,
    itemdcode: localMeta?.itemdcode ?? imsMeta?.itemdcode ?? imsMeta?.item_dcode ?? null,
    item_code: localMeta?.item_code ?? imsMeta?.item_code ?? null,
    item_desc: localMeta?.item_desc ?? imsMeta?.item_desc ?? null,
    acc_name: localMeta?.acc_name ?? imsMeta?.acc_name ?? null,
  };
}
