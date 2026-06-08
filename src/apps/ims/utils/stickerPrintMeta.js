import { findDailyProdByDocNo } from "../models/box.model.js";
import {
  findFinancialYearForPacking,
  findFinancialYearForSaId,
} from "../models/stockAdjustment.model.js";
import { fetchFromIMS } from "../services/ims.service.js";
import { imsPackRowToProduction, findImsPackByDocNo } from "./imsPackRow.js";
import { fetchPackRowsForFinancialYearDoc } from "./imsPackFyDoc.js";
import {
  enrichRowsWithIMS,
  resolvePartyRateCustCodeFromIms,
} from "./imsLookup.js";
import { effectiveBoxCustomerAcc } from "./boxCustomerOverride.js";

async function fetchImsPackProductionByDocNo(doc_no) {
  const pn = String(doc_no ?? "").trim();
  if (!pn) return null;
  try {
    const records = await fetchFromIMS("pack");
    return imsPackRowToProduction(findImsPackByDocNo(records, pn));
  } catch {
    return null;
  }
}

async function resolveFinancialYearForPrint(packing_number, hints = {}) {
  const fromHints =
    hints.financial_year != null && String(hints.financial_year).trim() !== ""
      ? String(hints.financial_year).trim()
      : null;
  if (fromHints) return fromHints;

  const saId = Number(hints.sa_id);
  if (Number.isFinite(saId) && saId > 0) {
    const fySa = await findFinancialYearForSaId(saId);
    if (fySa) return fySa;
  }

  return findFinancialYearForPacking(packing_number);
}

/** Same IMS pack row as stock adjustment view (`getPackByFinancialYearDoc`). */
async function fetchImsPackByFinancialYearDoc(packing_number, financial_year) {
  const pn = String(packing_number ?? "").trim();
  const fy = String(financial_year ?? "").trim();
  if (!pn || !fy) return null;
  try {
    const out = await fetchPackRowsForFinancialYearDoc(fy, pn);
    if (!out?.success || !Array.isArray(out.records) || out.records.length < 1) return null;
    return out.records[0];
  } catch {
    return null;
  }
}

/**
 * Packing-level sticker fields (customer, JC, item, cust code) for print/preview.
 * Order: ims_dailyprod → IMS pack by financial year (SA view path) → broad IMS pack fallback.
 */
export async function resolvePackingStickerMetaForPrint(packing_number, hints = {}) {
  const pn = String(packing_number ?? "").trim();
  if (!pn) return {};

  let itemdcode = hints.itemdcode ?? hints.item_dcode ?? null;
  let acc_code = hints.acc_code ?? null;
  let job_card_no = hints.job_card_no ?? hints.job_no ?? null;
  let acc_name = hints.acc_name ?? null;

  const dp = await findDailyProdByDocNo(pn);
  if (dp) {
    itemdcode = itemdcode ?? dp.itemdcode ?? null;
    acc_code = acc_code ?? dp.acc_code ?? null;
    job_card_no = job_card_no ?? dp.job_card_no ?? null;
  }

  const fy = await resolveFinancialYearForPrint(pn, hints);
  if (fy) {
    const packRow = await fetchImsPackByFinancialYearDoc(pn, fy);
    if (packRow) {
      itemdcode = itemdcode ?? packRow.itemdcode ?? null;
      acc_code = acc_code ?? packRow.acc_code ?? null;
      job_card_no = job_card_no ?? packRow.jobcardno ?? null;
      acc_name = acc_name ?? packRow.acc_name ?? null;
    }
  }

  if (!acc_code || !job_card_no || !itemdcode) {
    const ims = await fetchImsPackProductionByDocNo(pn);
    if (ims) {
      itemdcode = itemdcode ?? ims.itemdcode ?? null;
      acc_code = acc_code ?? ims.acc_code ?? null;
      job_card_no = job_card_no ?? ims.job_card_no ?? null;
    }
  }

  const packingAcc =
    hints.acc_code != null && String(hints.acc_code).trim() !== ""
      ? String(hints.acc_code).trim()
      : acc_code != null && String(acc_code).trim() !== ""
        ? String(acc_code).trim()
        : null;
  const customerAcc =
    effectiveBoxCustomerAcc(hints.override_cust, packingAcc) ?? packingAcc;

  const [enriched] = await enrichRowsWithIMS(
    [
      {
        itemdcode,
        item_dcode: itemdcode,
        acc_code: customerAcc,
      },
    ],
    {
      itemCodeField: "itemdcode",
      accCodeField: "acc_code",
      itemCodeOut: "item_code",
      itemDescOut: "itemdesc",
      accNameOut: "acc_name",
    }
  );

  const party_rate_cust_code = customerAcc
    ? await resolvePartyRateCustCodeFromIms({
        itemdcode,
        item_code: enriched?.item_code ?? hints.item_code,
        acc_code: customerAcc,
      })
    : null;

  return {
    packing_number: pn,
    doc_no: pn,
    itemdcode,
    item_code: enriched?.item_code ?? hints.item_code ?? null,
    itemdesc:
      enriched?.itemdesc ??
      hints.itemdesc ??
      hints.description ??
      hints.item_desc ??
      null,
    description:
      enriched?.itemdesc ??
      hints.description ??
      hints.itemdesc ??
      null,
    acc_code: customerAcc,
    acc_name: hints.acc_name ?? enriched?.acc_name ?? acc_name ?? null,
    job_card_no: job_card_no || null,
    job_no: job_card_no || null,
    party_rate_cust_code:
      party_rate_cust_code != null && String(party_rate_cust_code).trim() !== ""
        ? String(party_rate_cust_code).trim()
        : null,
  };
}
