/**
 * ONE-TIME: ERP invreceiving (attachments) → ims_gate_entry.
 *
 * After first successful run on live backup → COMMENT OUT the call in
 * `src/backfills/index.js` so it never runs again.
 * Uncomment later only if you need to re-import.
 */
import dbQuery from "../config/db/db.js";
import { IMS_TABLES as T } from "../config/db/dbTables.js";
import { fetchImsDataRaw } from "../apps/ims/lib/services/ims.service.js";
import { isErpNullString, parseReceivingFilePaths, parseReceivingMeta, receivingMetaToString, serializeReceivingFile } from "../apps/ims/modules/invoice-receiving/utils/buildInvReceivingUploadFilter.js";

function billOf(r) {
  return String(r?.prnbillno ?? r?.billno ?? r?.bill_no ?? "").trim();
}

function fileRaw(r) {
  return r?.receivingfile ?? r?.receiving_file ?? r?.file_path;
}

function hasFile(r) {
  return parseReceivingFilePaths(fileRaw(r)).length > 0;
}

function metaOf(r) {
  const m = parseReceivingMeta(r?.receiverefno ?? r?.receiving_meta);
  if (m) return receivingMetaToString(m);
  return receivingMetaToString({
    remarks: String(r?.remarks ?? "").trim(),
    approved: r?.approved === true || String(r?.approved ?? "").toLowerCase() === "true",
    approved_by: String(r?.approved_by ?? "").trim(),
    approved_at: String(r?.approved_at ?? "").trim(),
    uploaded_by: String(r?.uploaded_by ?? "").trim(),
    uploaded_at: String(r?.uploaded_at ?? "").trim(),
    acc_name: String(r?.acc_name ?? "").trim(),
    transport: String(r?.transport ?? "").trim(),
    vehicleno: String(r?.vehicleno ?? "").trim(),
  });
}

export async function runImportErpInvoiceReceivingToGate() {
  const json = await fetchImsDataRaw("invreceiving", { type: "register" });
  if (!json?.success) {
    throw new Error(json?.message || "ERP invreceiving register failed");
  }

  const rows = (Array.isArray(json.records) ? json.records : []).filter(hasFile);
  let updated = 0;
  let noGate = 0;

  for (const rec of rows) {
    const bill = billOf(rec);
    if (!bill) continue;

    const receiving_file = serializeReceivingFile(parseReceivingFilePaths(fileRaw(rec)));
    if (!receiving_file || isErpNullString(receiving_file)) continue;

    const out = await dbQuery(
      `
      UPDATE ${T.GATE_ENTRY}
      SET
        invoice_matched = true,
        receiving_file = $2,
        receiving_meta = $3
      WHERE is_deleted = false
        AND LOWER(TRIM(bill_no)) = LOWER($1)
        AND NULLIF(TRIM(COALESCE(receiving_file, '')), '') IS NULL
      RETURNING uid
      `,
      [bill, receiving_file, metaOf(rec)]
    );

    if (out?.length) updated += out.length;
    else noGate += 1;
  }

  console.log(`✅ IR→gate backfill: updated=${updated}, skipped/noGate=${noGate}, erpWithFile=${rows.length}`);
  return { updated, noGate, erpWithFile: rows.length };
}
