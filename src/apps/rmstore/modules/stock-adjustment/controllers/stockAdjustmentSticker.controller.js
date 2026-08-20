/**
 * Stock Adjustment stickers — RM coil design (same as MRN Portal), not IMS FG boxes.
 */
import { findMrnByUid } from "../../mrn/models/mrn.model.js";
import { findCoilByUid, incrementCoilDownloadCount } from "../../coil/models/coil.model.js";
import { insertCoilDownloadLog } from "../../coil/models/coilDownloadLog.model.js";
import { findAdjustmentById, updateAdjustment } from "../models/stockAdjustment.model.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { toRmPublicUploadPath } from "../../../lib/middleware/upload.js";
import { buildCoilStickerCardHtml, buildCoilStickerPrintDocument, buildCoilStickerPrintDocumentTitle, buildCoilStickerPrintRow, resolveSpecStickerFields } from "../../../lib/sticker/coilStickerDesign.js";
import { isSaAddLikeEntryType, normalizeSaApproved } from "../utils/stockAdjustmentEntryTypes.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";

const STICKER_EMPTY = "—";
const log = createRmstoreActivityLogger("rm_stock_adjustment");

function isSaStockInCoil(coil) {
  const saId = coil?.sa_id != null ? Number(coil.sa_id) : null;
  if (!saId) return false;
  const entryType = String(coil?.sa_entry_type ?? "stock_in")
    .trim()
    .toLowerCase();
  return entryType === "stock_in" || entryType === "";
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s && s !== STICKER_EMPTY) return s;
  }
  return null;
}

/** Merge adjustment + client meta onto coil/MRN before spec/sticker mapping. */
function enrichSaCoilSources(coil = {}, mrn = {}, adjustment = {}) {
  const adj = adjustment && typeof adjustment === "object" ? adjustment : {};
  const m = mrn && typeof mrn === "object" ? mrn : {};
  const lotNo = pickFirstNonEmpty(adj.it_lot_no, adj.heat_no, coil.it_lot_no, m.it_lot_no, coil.heat_no, m.heat_no);

  return {
    coil: {
      ...coil,
      item_dcode: coil.item_dcode ?? m.item_dcode ?? adj.item_dcode ?? null,
      item_code: pickFirstNonEmpty(coil.item_code, m.item_code, adj.item_code),
      item_desc: pickFirstNonEmpty(coil.item_desc, m.item_desc, adj.item_desc),
      acc_code: coil.acc_code ?? m.acc_code ?? adj.acc_code ?? null,
      acc_name: pickFirstNonEmpty(coil.acc_name, m.acc_name, adj.acc_name),
      mrn_no: coil.mrn_no ?? m.mrn_no ?? adj.mrn_no ?? null,
      mrn_dt: pickFirstNonEmpty(m.mrn_dt, adj.mrn_dt, adj.bill_dt, adj.doc_dt, adj.approved_at, coil.created_at),
      bill_no: pickFirstNonEmpty(m.bill_no, adj.bill_no),
      bill_dt: pickFirstNonEmpty(m.bill_dt, adj.bill_dt),
      it_lot_no: lotNo,
      heat_no: lotNo,
    },
    mrn: {
      ...m,
      item_dcode: m.item_dcode ?? adj.item_dcode ?? null,
      item_code: pickFirstNonEmpty(m.item_code, adj.item_code),
      item_desc: pickFirstNonEmpty(m.item_desc, adj.item_desc),
      acc_code: m.acc_code ?? adj.acc_code ?? null,
      acc_name: pickFirstNonEmpty(m.acc_name, adj.acc_name),
      mrn_no: m.mrn_no ?? adj.mrn_no ?? null,
      mrn_dt: pickFirstNonEmpty(m.mrn_dt, adj.mrn_dt, adj.bill_dt, adj.doc_dt),
      bill_no: pickFirstNonEmpty(m.bill_no, adj.bill_no),
      bill_dt: pickFirstNonEmpty(m.bill_dt, adj.bill_dt),
      it_lot_no: lotNo,
      heat_no: lotNo,
      it_unit: pickFirstNonEmpty(m.it_unit, adj.unit, "KG"),
    },
  };
}

async function assertApprovedSaCoil(coil) {
  if (!isSaStockInCoil(coil)) {
    const err = new Error("This coil is not linked to an approved stock adjustment.");
    err.statusCode = 400;
    throw err;
  }
  const saId = Number(coil.sa_id);
  const adj = await findAdjustmentById(saId);
  if (!adj || !normalizeSaApproved(adj.approved) || !isSaAddLikeEntryType(adj.entry_type)) {
    const err = new Error("Approve the stock adjustment before printing coil stickers.");
    err.statusCode = 403;
    throw err;
  }
  return adj;
}

function mergeSaStickerMeta(printRow, { adjustment, stickerMeta, coil } = {}) {
  const out = { ...printRow };
  const adj = adjustment && typeof adjustment === "object" ? adjustment : {};
  const meta = stickerMeta && typeof stickerMeta === "object" ? stickerMeta : {};
  const coilRow = coil && typeof coil === "object" ? coil : {};

  const itemCode = pickFirstNonEmpty(meta.item_code, adj.item_code, out.item_code);
  if (itemCode) out.item_code = itemCode;

  const itemDesc = pickFirstNonEmpty(meta.item_desc, meta.itemdesc, adj.item_desc, out.itemdesc);
  if (itemDesc) {
    out.itemdesc = itemDesc;
    if (!out.grade || out.grade === STICKER_EMPTY) out.grade = itemDesc;
  }

  const accName = pickFirstNonEmpty(meta.acc_name, adj.acc_name, out.acc_name);
  if (accName) out.acc_name = accName;

  const lotNo = pickFirstNonEmpty(
    meta.lot_no,
    meta.heat_no,
    meta.it_lot_no,
    adj.it_lot_no,
    adj.heat_no,
    out.lot_no,
    out.job_no
  );
  if (lotNo) {
    out.lot_no = lotNo;
    out.job_no = lotNo;
  }

  const docDt = pickFirstNonEmpty(
    meta.doc_dt,
    meta.mrn_dt,
    adj.mrn_dt,
    meta.bill_dt,
    adj.bill_dt,
    adj.doc_dt,
    adj.approved_at,
    out.doc_dt
  );
  if (docDt) out.doc_dt = docDt;

  const billNo = pickFirstNonEmpty(meta.bill_no, adj.bill_no);
  if (billNo && (!out.work_order_no || out.work_order_no === STICKER_EMPTY)) {
    out.work_order_no = billNo;
  }

  const qty = Number(meta.qty ?? coilRow.qty ?? out.qty);
  if (Number.isFinite(qty) && qty > 0) out.qty = Math.round(qty);

  const unit = pickFirstNonEmpty(meta.unit, adj.unit, out.unit, "KG");
  if (unit) out.unit = unit;

  const packing = pickFirstNonEmpty(
    meta.packing_number,
    meta.mrn_no != null ? String(meta.mrn_no) : null,
    adj.mrn_no != null ? String(adj.mrn_no) : null,
    adj.adjustment_id != null ? `SA-${adj.adjustment_id}` : null,
    out.packing_number
  );
  if (packing) out.packing_number = packing;

  const uid = pickFirstNonEmpty(meta.coil_no_uid, coilRow.coil_no_uid, out.coil_no_uid, out.box_no_uid);
  if (uid) {
    out.coil_no_uid = uid;
    out.box_no_uid = uid;
  }

  return out;
}

async function renderSaCoilStickerHtml(coil, req, { bulk = false } = {}) {
  const adjustment = await assertApprovedSaCoil(coil);
  const mrn = coil.mrn_uid ? await findMrnByUid(coil.mrn_uid) : null;
  const { coil: coilSrc, mrn: mrnSrc } = enrichSaCoilSources(coil, mrn || {}, adjustment);
  const spec = await resolveSpecStickerFields(coilSrc, mrnSrc || {});
  let printRow = buildCoilStickerPrintRow(coilSrc, mrnSrc || {}, { isQc: false, spec });
  printRow = mergeSaStickerMeta(printRow, {
    adjustment,
    stickerMeta: req.body?.sticker_meta,
    coil: coilSrc,
  });
  const card = await buildCoilStickerCardHtml(printRow);
  const html = buildCoilStickerPrintDocument([card], { mrn_no: coilSrc.mrn_no ?? mrnSrc?.mrn_no });
  const print_title = buildCoilStickerPrintDocumentTitle(
    coilSrc.mrn_no ?? mrnSrc?.mrn_no ?? `SA-${coil.sa_id || ""}`
  );

  if (!String(html || "").trim()) {
    const err = new Error("Sticker HTML was empty — could not prepare print.");
    err.statusCode = 500;
    throw err;
  }

  try {
    await insertCoilDownloadLog({
      coil_no_uid: coil.coil_no_uid,
      mrn_uid: coil.mrn_uid,
      mrn_no: coilSrc.mrn_no ?? mrnSrc?.mrn_no,
      heat_no: coilSrc.heat_no ?? mrnSrc?.heat_no,
      item_code: printRow.item_code,
      acc_name: printRow.acc_name,
      downloaded_by_id: req.user?.id,
      downloaded_by: auditUserName(req),
      download_type: bulk ? "bulk" : "single",
      sticker_count: 1,
      download_source: String(req.body?.download_source || "").trim() || "stock_adjustment",
    });
    await incrementCoilDownloadCount([coil.coil_no_uid]);
  } catch (logErr) {
    console.error("[SA coil sticker download log]", logErr?.message || logErr);
  }

  return { html, print_title };
}

export const renderSingleSaCoilSticker = async (req, res) => {
  try {
    const coil_no_uid = String(req.body?.coil_no_uid || "").trim();
    if (!coil_no_uid) {
      return res.status(400).json({ success: false, message: "Coil UID is required." });
    }
    const coil = await findCoilByUid(coil_no_uid);
    if (!coil) return res.status(404).json({ success: false, message: "Coil not found." });

    const { html, print_title } = await renderSaCoilStickerHtml(coil, req);
    return res.json({ success: true, html, print_title });
  } catch (err) {
    console.error("renderSingleSaCoilSticker Error:", err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Could not generate the sticker." });
  }
};

export const renderBulkSaCoilStickers = async (req, res) => {
  try {
    const uids = Array.isArray(req.body?.coil_no_uids)
      ? req.body.coil_no_uids.map((u) => String(u || "").trim()).filter(Boolean)
      : [];
    if (!uids.length) {
      return res.status(400).json({ success: false, message: "At least one coil UID is required." });
    }

    const cards = [];
    let mrnNo = null;
    let bulkMrnUid = null;
    const stickerMeta = req.body?.sticker_meta;
    for (const uid of uids) {
      const coil = await findCoilByUid(uid);
      if (!coil) continue;
      const adjustment = await assertApprovedSaCoil(coil);
      const mrn = coil.mrn_uid ? await findMrnByUid(coil.mrn_uid) : null;
      const { coil: coilSrc, mrn: mrnSrc } = enrichSaCoilSources(coil, mrn || {}, adjustment);
      mrnNo = mrnNo ?? coilSrc.mrn_no ?? mrnSrc?.mrn_no;
      bulkMrnUid = bulkMrnUid ?? coil.mrn_uid;
      const spec = await resolveSpecStickerFields(coilSrc, mrnSrc || {});
      let printRow = buildCoilStickerPrintRow(coilSrc, mrnSrc || {}, { isQc: false, spec });
      printRow = mergeSaStickerMeta(printRow, { adjustment, stickerMeta, coil: coilSrc });
      cards.push(await buildCoilStickerCardHtml(printRow));
    }
    if (!cards.length) {
      return res.status(404).json({ success: false, message: "No coils were found for printing." });
    }

    const html = buildCoilStickerPrintDocument(cards, { mrn_no: mrnNo });
    const print_title = buildCoilStickerPrintDocumentTitle(mrnNo ?? "Stock Adjustment");

    try {
      await insertCoilDownloadLog({
        coil_no_uid: null,
        mrn_uid: bulkMrnUid,
        mrn_no: mrnNo,
        downloaded_by_id: req.user?.id,
        downloaded_by: auditUserName(req),
        download_type: "bulk",
        sticker_count: cards.length,
        download_source: String(req.body?.download_source || "").trim() || "stock_adjustment",
      });
      await incrementCoilDownloadCount(uids);
    } catch (logErr) {
      console.error("[SA bulk sticker download log]", logErr?.message || logErr);
    }

    return res.json({ success: true, html, print_title, count: cards.length });
  } catch (err) {
    console.error("renderBulkSaCoilStickers Error:", err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Could not generate stickers." });
  }
};

export const uploadSaDocs = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.adjustment_id);
    if (!id) {
      return res.status(400).json({ success: false, message: "A valid adjustment ID is required." });
    }
    const existing = await findAdjustmentById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Stock adjustment not found." });
    }

    const tcFile = req.files?.tc?.[0] || null;
    const rmtcFile = req.files?.rmtc?.[0] || null;
    if (!tcFile && !rmtcFile) {
      return res.status(400).json({ success: false, message: "Upload at least one document (TC or RMTC)." });
    }

    const fields = { updated_by: auditUserName(req), updated_at: new Date() };
    if (tcFile) {
      fields.tc_file_path = toRmPublicUploadPath(tcFile, "tc");
      fields.tc_file_name = tcFile.originalname;
    }
    if (rmtcFile) {
      fields.rmtc_file_path = toRmPublicUploadPath(rmtcFile, "rmtc");
      fields.rmtc_file_name = rmtcFile.originalname;
    }

    await updateAdjustment(fields, { adjustment_id: id });
    const data = await findAdjustmentById(id);
    log(req, "upload_docs", String(id), {
      adjustment_id: id,
      old_values: {
        tc_file_name: existing.tc_file_name ?? null,
        rmtc_file_name: existing.rmtc_file_name ?? null,
      },
      new_values: {
        tc_file_name: data?.tc_file_name ?? existing.tc_file_name ?? null,
        rmtc_file_name: data?.rmtc_file_name ?? existing.rmtc_file_name ?? null,
      },
      uploaded_tc: Boolean(tcFile),
      uploaded_rmtc: Boolean(rmtcFile),
    }, data);
    return res.json({ success: true, data, message: "Documents uploaded." });
  } catch (err) {
    console.error("uploadSaDocs Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Could not upload documents." });
  }
};
