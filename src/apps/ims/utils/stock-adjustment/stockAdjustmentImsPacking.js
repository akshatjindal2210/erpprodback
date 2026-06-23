/**
 * IMS internal pack API → stock adjustment fields (doc_dt, job_card_no).
 * API shape: { docno, docdt, jobcardno, acc_code, itemdcode, ... }
 */

import { fetchPackRowsForFinancialYearDoc, rowInIndianFinancialYear } from "../../services/ims.service.js";
import { findImsPackByDocNo, imsPackRowToProduction, imsPackToDisplayMeta } from "../erp-api/imsPackRow.js";
import { normalizeDocDtForDb } from "../packing-entry/packRowParse.js";

function packingMetaFromImsPackRow(row) {
  if (!row) return null;
  const display = imsPackToDisplayMeta(row);
  const prod = imsPackRowToProduction(row);
  const doc_dt = normalizeDocDtForDb(display?.doc_dt ?? prod?.doc_dt);
  const job_card_no =
    display?.job_card_no != null && String(display.job_card_no).trim() !== ""
      ? String(display.job_card_no).trim()
      : prod?.job_card_no != null && String(prod.job_card_no).trim() !== ""
        ? String(prod.job_card_no).trim()
        : null;
  const item_code = display?.item_code ?? null;
  const item_desc = display?.item_desc ?? null;
  const acc_name = display?.acc_name ?? null;
  const acc_code = display?.acc_code ?? prod?.acc_code ?? null;
  const itemdcode = display?.item_dcode ?? prod?.itemdcode ?? null;

  if (!doc_dt && !job_card_no && !item_code && !item_desc && !acc_name) return null;

  return {
    doc_dt,
    job_card_no,
    item_code,
    item_desc,
    acc_name,
    acc_code,
    itemdcode,
  };
}

/**
 * Fetch one packing row from IMS for SA (financial year + docno required).
 * `docdt` e.g. "02-04-2025" → DB `2025-04-02`; `jobcardno` → job_card_no.
 */
export async function fetchSaPackingMetaFromIms(
  packingNumber,
  financialYear,
  { itemDcode, accCode } = {}
) {
  const pn = String(packingNumber ?? "").trim();
  const fy = String(financialYear ?? "").trim();
  if (!pn || !fy) return null;

  const ims = await fetchPackRowsForFinancialYearDoc(fy, pn);
  if (!ims?.success || !ims.records?.length) return null;

  const row =
    findImsPackByDocNo(ims.records, pn, {
      financialYear: fy,
      itemDcode,
      accCode,
      rowInFinancialYear: rowInIndianFinancialYear,
    }) ?? ims.records[0];

  return packingMetaFromImsPackRow(row);
}
