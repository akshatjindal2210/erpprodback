/**
 * Normalise one IMS `pack` record (mixed legacy / lowercase keys) for sticker / daily-prod flows.
 */

function formatPackDocDate(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s.includes("-")) return s;
  const parts = s.split("-").map((p) => p.trim());
  if (parts.length !== 3) return s;
  const [p0, p1, p2] = parts;
  if (p0.length === 4) return `${p0}-${p1.padStart(2, "0")}-${p2.padStart(2, "0")}`;
  if (p2.length === 4) return `${p2}-${p1.padStart(2, "0")}-${p0.padStart(2, "0")}`;
  return s;
}

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

  const doc_dt = formatPackDocDate(rawDate) ?? (rawDate != null ? String(rawDate) : null);

  return {
    doc_no,
    doc_dt,
    job_card_no,
    acc_code: accCode,
    itemdcode: itemDcode,
    total_qty: String(qty ?? "0"),
    sticker_generated: false,
    packing_standard_id: null
  };
}

export function findImsPackByDocNo(records, doc_no) {
  const want = String(doc_no ?? "");
  if (!want || !Array.isArray(records)) return null;
  return (
    records.find((r) => String(imsPackDocNo(r) ?? "") === want) ?? null
  );
}
