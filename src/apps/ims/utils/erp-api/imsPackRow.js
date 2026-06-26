/**
 * Normalise one IMS `pack` record (mixed legacy / lowercase keys) for sticker / daily-prod flows.
 */

import { formatPackDocDate, normalizeDocDtForDb } from "../packing-entry/packRowParse.js";

export function imsPackDocNo(r) {
  if (!r) return null;
  return r.docno ?? r.doc_no ?? r["Doc No"] ?? r.Doc_No ?? r.DocNo ?? null;
}

export function imsPackRowToProduction(r) {
  if (!r) return null;

  const doc_no = imsPackDocNo(r);
  if (doc_no == null || doc_no === "") return null;

  const rawDate =
    r.docdt ??
    r.doc_dt ??
    r["Doc Dt"] ??
    r.Doc_Dt ??
    r.DocDt ??
    r.doc_dt;

  const itemDcode =
    r.itemdcode ?? r.ItemDcode ?? r.Itemdcode ?? r.item_dcode ?? null;

  const accCode = r.acc_code ?? r.Acc_Code ?? r.AccCode ?? r.acc_Code ?? null;

  const job_card_no =
    r.jobcardno ??
    r.job_card_no ??
    r["Job Card No"] ??
    r.Job_Card_No ??
    r.JobCardNo ??
    null;

  const qty = r.QTY ?? r.qty ?? r.Total_Qty ?? r.TotalQty ?? r.total_qty ?? "0";

  const doc_dt =
    normalizeDocDtForDb(formatPackDocDate(rawDate) ?? rawDate) ??
    (rawDate != null ? String(rawDate) : null);

  const internal_create_user = r.userc ?? r.Userc ?? r.UserC ?? null;
  const internal_create_date = r.datec ?? r.Datec ?? r.DateC ?? null;

  return {
    doc_no,
    doc_dt,
    job_card_no,
    acc_code: accCode,
    itemdcode: itemDcode,
    total_qty: String(qty ?? "0"),
    sticker_generated: false,
    packing_standard_id: null,
    internal_create_user,
    internal_create_date,
  };
}

/** Full packing display fields from one IMS `pack` row (raw or normalized). */
export function imsPackToDisplayMeta(r) {
  if (!r) return null;
  const prod = imsPackRowToProduction(r);
  if (!prod && imsPackDocNo(r) == null) return null;

  return {
    doc_dt: prod?.doc_dt ?? normalizeDocDtForDb(r.doc_dt ?? r.docdt) ?? null,
    job_card_no:
      prod?.job_card_no ??
      r.jobcardno ??
      r.job_card_no ??
      r.Job_Card_No ??
      r["Job Card No"] ??
      null,
    item_dcode: prod?.itemdcode ?? r.itemdcode ?? r.item_dcode ?? null,
    item_code: r.item_code ?? r.Item_Code ?? r.ItemCode ?? null,
    acc_name: r.acc_name ?? r.Acc_Name ?? r.AccName ?? null,
    acc_code: prod?.acc_code ?? r.acc_code ?? r.Acc_Code ?? null,
    item_desc: r.itemdesc ?? r.item_desc ?? r.ItemDesc ?? null,
    internal_create_user: prod?.internal_create_user ?? r.userc ?? r.Userc ?? r.UserC ?? null,
    internal_create_date: prod?.internal_create_date ?? r.datec ?? r.Datec ?? r.DateC ?? null,
  };
}

function packMatchCode(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" || s === "—" ? null : s;
}

function packRowDocDt(r) {
  const prod = imsPackRowToProduction(r);
  return prod?.doc_dt ?? normalizeDocDtForDb(r?.doc_dt ?? r?.docdt) ?? null;
}

/**
 * Same docno can exist in multiple FY / items (e.g. 16808 in 2022 and 2025).
 * Prefer financial year, then item dcode, then customer code; oldest doc_dt as tie-break.
 */
export function pickBestImsPackRow(records, doc_no, options = {}) {
  const want = String(doc_no ?? "").trim();
  if (!want || !Array.isArray(records)) return null;

  const matches = records.filter((r) => String(imsPackDocNo(r) ?? "") === want);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];

  const wantItem = packMatchCode(options.itemDcode ?? options.item_dcode);
  const wantAcc = packMatchCode(options.accCode ?? options.acc_code);
  const wantFy = options.financialYear != null ? String(options.financialYear).trim() : "";
  const fyChecker = typeof options.rowInFinancialYear === "function" ? options.rowInFinancialYear : null;

  const scored = matches.map((r) => {
    let score = 0;
    const item = packMatchCode(r.itemdcode ?? r.item_dcode ?? r.ItemDcode);
    const acc = packMatchCode(r.acc_code ?? r.Acc_Code);
    const docDt = packRowDocDt(r);

    if (wantFy && fyChecker) {
      const isoRow = { doc_dt: docDt };
      if (docDt && fyChecker(isoRow, wantFy)) score += 100;
    }
    if (wantItem && item && wantItem === item) score += 50;
    if (wantAcc && acc && wantAcc === acc) score += 40;

    return { r, score, docDt: docDt ?? "" };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.docDt).localeCompare(String(b.docDt));
  });

  return scored[0]?.r ?? matches[0];
}

export function findImsPackByDocNo(records, doc_no, options) {
  if (options && Object.keys(options).length) {
    return pickBestImsPackRow(records, doc_no, options);
  }
  const want = String(doc_no ?? "");
  if (!want || !Array.isArray(records)) return null;
  return records.find((r) => String(imsPackDocNo(r) ?? "") === want) ?? null;
}

/** IMS `pack` filter for one packing / doc no. */
export function buildImsDocFilter(docNo) {
  const pn = String(docNo ?? "").trim();
  if (!pn) return null;
  const n = parseInt(pn, 10);
  return Number.isFinite(n)
    ? `dailyprod.docno = ${n}`
    : `dailyprod.docno = '${pn.replace(/'/g, "''")}'`;
}

/** Single IMS request for many packings (`docno = 1 or docno = 2`). */
export function buildImsDocFilterMany(docNos = []) {
  const list = [...new Set(docNos.map((d) => String(d ?? "").trim()).filter(Boolean))];
  if (!list.length) return null;
  if (list.length === 1) return buildImsDocFilter(list[0]);
  return list.map((pn) => buildImsDocFilter(pn)).join(" or ");
}
