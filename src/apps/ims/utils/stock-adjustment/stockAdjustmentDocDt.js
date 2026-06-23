import { updateAdjustmentsTx, findFinancialYearForPacking } from "../../models/stockAdjustment.model.js";
import { fetchSaPackingMetaFromIms } from "./stockAdjustmentImsPacking.js";
import { resolveStockAdjustmentPackingMeta } from "./stockAdjustmentPacking.js";
import { mergeAdjustmentPackingMeta, packingMetaToSaDbFields } from "./stockAdjustmentPackingSnapshot.js";

const PACKING_ENTRY_TYPES = new Set(["add", "minus"]);

function isPackingEntry(adjustment) {
  return PACKING_ENTRY_TYPES.has(String(adjustment?.entry_type ?? "").trim());
}

async function resolveFy(adjustment) {
  const fromRow =
    adjustment?.financial_year != null && String(adjustment.financial_year).trim() !== ""
      ? String(adjustment.financial_year).trim()
      : "";
  if (fromRow) return fromRow;
  const pn = String(adjustment?.packing_number ?? "").trim();
  if (!pn) return "";
  return (await findFinancialYearForPacking(pn)) || "";
}

async function resolveAdjustmentPackingMeta(adjustment) {
  const pn = String(adjustment?.packing_number ?? "").trim();
  if (!pn || !isPackingEntry(adjustment)) return null;

  const fy = await resolveFy(adjustment);
  if (!fy) return null;

  const [imsMeta, localMeta] = await Promise.all([
    fetchSaPackingMetaFromIms(pn, fy, {
      itemDcode: adjustment.item_dcode,
      accCode: adjustment.acc_code,
    }),
    resolveStockAdjustmentPackingMeta(pn, {
      adjustment_id: adjustment.adjustment_id,
      item_dcode: adjustment.item_dcode,
      financial_year: fy,
    }),
  ]);

  const merged = mergeAdjustmentPackingMeta(imsMeta, localMeta);
  if (!merged) return null;
  return { ...merged, doc_no: pn };
}

/** Resolve packing meta (date + display names) and save on the adjustment row (transaction). */
export async function persistAdjustmentDocDtTx(client, adjustment) {
  const meta = await resolveAdjustmentPackingMeta(adjustment);
  const fields = packingMetaToSaDbFields(meta, { existing: adjustment });
  if (!Object.keys(fields).length) return meta;
  await updateAdjustmentsTx(
    client,
    { ...fields, updated_at: new Date() },
    { adjustment_id: adjustment.adjustment_id }
  );
  return meta;
}
