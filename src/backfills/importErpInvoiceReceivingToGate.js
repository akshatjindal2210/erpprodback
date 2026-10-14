/**
 * ONE-TIME: ERP invreceiving (attachments) → ims_gate_entry (meta) + `documents` (files).
 *
 * After first successful run on live backup → COMMENT OUT the call in
 * `src/backfills/index.js` so it never runs again.
 * Uncomment later only if you need to re-import.
 */
import fs from "fs";
import path from "path";
import dbQuery from "../config/db/db.js";
import { IMS_TABLES as T } from "../config/db/dbTables.js";
import { fetchImsDataRaw } from "../apps/ims/lib/services/ims.service.js";
import { isErpNullString, parseReceivingFilePaths, parseReceivingMeta, receivingMetaToString } from "../apps/ims/modules/invoice-receiving/utils/buildInvReceivingUploadFilter.js";
import { moduleDocuments } from "../lib/documents/index.js";
import { folderOf, fileDocPath } from "../lib/documents/documents.config.js";
import { absUploadPath, normDocPath } from "../lib/documents/documents.utils.js";

const MODULE = "invoice_receiving";
const irDocuments = moduleDocuments(MODULE);

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

/** ERP path on disk: as given, else the same name in the IR upload folder (null when missing). */
function onDisk(p) {
  const cur = normDocPath(p).replace(/^\/+/, "");
  if (cur && fs.existsSync(absUploadPath(cur))) return cur;
  const alt = normDocPath(fileDocPath(folderOf(MODULE), path.basename(cur)));
  return fs.existsSync(absUploadPath(alt)) ? alt : null;
}

export async function runImportErpInvoiceReceivingToGate() {
  const json = await fetchImsDataRaw("invreceiving", { type: "register" });
  if (!json?.success) {
    throw new Error(json?.message || "ERP invreceiving register failed");
  }

  const rows = (Array.isArray(json.records) ? json.records : []).filter(hasFile);
  let updated = 0;
  let noGate = 0;
  let missing = 0;

  for (const rec of rows) {
    const bill = billOf(rec);
    if (!bill) continue;

    const paths = parseReceivingFilePaths(fileRaw(rec)).filter((p) => !isErpNullString(p));
    const found = paths.map(onDisk).filter(Boolean);
    missing += paths.length - found.length;
    if (!found.length) continue;

    // only gates that have no invoice receiving files yet
    const [gate] = await dbQuery(
      `
      UPDATE ${T.GATE_ENTRY}
      SET
        invoice_matched = true,
        receiving_meta = $2
      WHERE is_deleted = false
        AND LOWER(TRIM(bill_no)) = LOWER($1)
        AND COALESCE(jsonb_array_length(doc_files), 0) = 0
      RETURNING uid
      `,
      [bill, metaOf(rec)]
    );
    if (!gate) {
      noGate += 1;
      continue;
    }

    await irDocuments.saveFiles(gate.uid, found.map((docPath) => ({ docPath })), null);
    updated += 1;
  }

  console.log(`✅ IR→gate backfill: updated=${updated}, skipped/noGate=${noGate}, erpWithFile=${rows.length}, filesMissingOnDisk=${missing}`);
  return { updated, noGate, erpWithFile: rows.length, missing };
}
