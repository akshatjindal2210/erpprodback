import { findMrnByUid } from "../models/mrn.model.js";
import { findCoilByUid, findCoils, formatCoilNoUid, incrementCoilDownloadCount } from "../../coil/models/coil.model.js";
import { insertCoilDownloadLog } from "../../coil/models/coilDownloadLog.model.js";
import { getBoxNoUidPrefix } from "../../../../core/configuration/models/appConfig.model.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import {
  buildCoilStickerCardHtml,
  buildCoilStickerPreviewCardHtml,
  buildCoilStickerPreviewDocument,
  buildCoilStickerPrintDocument,
  buildCoilStickerPrintDocumentTitle,
  mapCoilToStickerPrintRow,
} from "../../../lib/sticker/coilStickerDesign.js";
import { splitQtyAcrossCoils } from "./mrnSticker.controller.js";

/** Accept boolean / "true" / sticker_kind=qc from JSON bodies. */
function isQcRequest(body = {}) {
  if (body?.is_qc === true || body?.is_qc === 1) return true;
  const flag = String(body?.is_qc ?? "").trim().toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes") return true;
  return String(body?.sticker_kind || "").trim().toLowerCase() === "qc";
}

/**
 * Preview coil 1 layout before DB insert (IMS-style).
 * body: mrn fields + coil_count, total_qty, coil_qtys?, heat_no?
 */
export const previewCoilSticker = async (req, res) => {
  try {
    const body = req.body || {};
    const coil_count = Math.max(1, Number(body.coil_count) || 1);
    let total_qty = body.total_qty != null && body.total_qty !== ""
      ? Number(body.total_qty)
      : Number(body.it_recp_qty ?? body.itrecpqty);
    if (!Number.isFinite(total_qty) || total_qty < 0) {
      return res.status(400).json({ success: false, message: "A valid total quantity is required." });
    }
    total_qty = Math.round(total_qty);

    let coil_qtys = null;
    if (Array.isArray(body.coil_qtys) && body.coil_qtys.length === coil_count) {
      coil_qtys = body.coil_qtys.map((q) => Math.round(Number(q) || 0));
    } else if (typeof body.coil_qtys === "string") {
      try {
        const parsed = JSON.parse(body.coil_qtys);
        if (Array.isArray(parsed) && parsed.length === coil_count) {
          coil_qtys = parsed.map((q) => Math.round(Number(q) || 0));
        }
      } catch { /* ignore */ }
    }
    if (!coil_qtys) coil_qtys = splitQtyAcrossCoils(total_qty, coil_count);

    const stickerPrefix = await getBoxNoUidPrefix();
    const mrn_no = body.mrn_no ?? body.mrnno ?? null;
    const serial_no = body.serial_no ?? body.itsrno ?? null;
    const heat_no = body.heat_no != null ? String(body.heat_no).trim() : "";

    const sampleCoil = {
      coil_no_uid: formatCoilNoUid({
        prefix: stickerPrefix,
        mrn_no,
        serial_no,
        total: coil_count,
        index: 1,
      }),
      qty: coil_qtys[0] ?? 0,
      heat_no: heat_no || null,
      item_code: body.item_code ?? body.itemcode,
      item_desc: body.item_desc ?? body.itemdesc,
      acc_name: body.acc_name,
      mrn_no,
      mrn_dt: body.mrn_dt ?? body.mrndt,
      it_unit: body.it_unit ?? body.itunit ?? "PCS",
    };

    const mrn = {
      mrn_no,
      mrn_dt: sampleCoil.mrn_dt,
      acc_name: sampleCoil.acc_name,
      item_code: sampleCoil.item_code,
      item_desc: sampleCoil.item_desc,
      it_unit: sampleCoil.it_unit,
      it_lot_no: body.it_lot_no ?? body.itLotNo,
    };

    const isQc = isQcRequest(body);
    const printRow = {
      ...mapCoilToStickerPrintRow(sampleCoil, mrn, { fillDummy: true }),
      ...(isQc ? { is_qc: true, sticker_kind: "qc" } : {}),
    };
    const card = await buildCoilStickerPreviewCardHtml(printRow);
    const html = buildCoilStickerPreviewDocument(card);

    return res.json({
      success: true,
      html,
      sample_coil_no_uid: sampleCoil.coil_no_uid,
      total_stickers: coil_count,
      message: "Coil sticker preview is ready.",
    });
  } catch (err) {
    console.error("previewCoilSticker Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Could not generate the sticker preview. Please try again." });
  }
};

/** Print / download one generated coil sticker (coil-wise mode). */
export const renderSingleCoilSticker = async (req, res) => {
  try {
    const coil_no_uid = String(req.body?.coil_no_uid || "").trim();
    if (!coil_no_uid) {
      return res.status(400).json({ success: false, message: "Coil UID is required." });
    }
    const isQc = isQcRequest(req.body);
    const coil = await findCoilByUid(coil_no_uid);
    if (!coil) return res.status(404).json({ success: false, message: "Coil not found." });

    const mrn = coil.mrn_uid ? await findMrnByUid(coil.mrn_uid) : null;
    const printRow = {
      ...mapCoilToStickerPrintRow(coil, mrn || {}),
      ...(isQc ? { is_qc: true, sticker_kind: "qc" } : {}),
    };
    const card = await buildCoilStickerCardHtml(printRow);
    const html = buildCoilStickerPrintDocument([card], { mrn_no: coil.mrn_no });
    const print_title = isQc
      ? (coil.mrn_no ? `MRN No. ${coil.mrn_no} — QC` : "QC Sticker")
      : buildCoilStickerPrintDocumentTitle(coil.mrn_no);

    try {
      await insertCoilDownloadLog({
        coil_no_uid: coil.coil_no_uid,
        mrn_no: coil.mrn_no,
        heat_no: coil.heat_no,
        item_code: coil.item_code,
        acc_name: coil.acc_name,
        downloaded_by: auditUserName(req),
        download_type: isQc ? "qc" : "single",
        sticker_count: 1,
        download_source:
          String(req.body?.download_source || "").trim() ||
          (isQc ? "mrn_sticker_render_qc" : "mrn_sticker_render"),
      });
      await incrementCoilDownloadCount([coil.coil_no_uid]);
    } catch (logErr) {
      console.error("[coil download log]", logErr?.message || logErr);
    }

    return res.json({ success: true, html, print_title });
  } catch (err) {
    console.error("renderSingleCoilSticker Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Could not generate the coil sticker. Please try again." });
  }
};

/** Print / download one batch QC sticker for an MRN (batch-wise mode). */
export const renderBatchQcSticker = async (req, res) => {
  try {
    const mrn_uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!mrn_uid) {
      return res.status(400).json({ success: false, message: "MRN UID is required." });
    }

    const mrn = await findMrnByUid(mrn_uid);
    if (!mrn) return res.status(404).json({ success: false, message: "MRN not found." });

    const result = await findCoils({
      filters: { mrn_uid },
      limit: 5000,
      sortBy: "coil_index",
      order: "ASC",
    });
    const coils = result.data || [];
    if (!coils.length) {
      return res.status(404).json({ success: false, message: "No coils were found for this batch." });
    }

    const base = coils[0];
    const totalQty = coils.reduce((sum, c) => sum + (Number(c.qty) || 0), 0);
    const batchCoil = {
      ...base,
      qty: totalQty,
      coil_no_uid: `${String(mrn_uid).trim()}_batch_qc`,
      total_coils: coils.length,
    };

    const printRow = {
      ...mapCoilToStickerPrintRow(batchCoil, mrn),
      is_qc: true,
      sticker_kind: "qc",
    };
    const card = await buildCoilStickerCardHtml(printRow);
    const html = buildCoilStickerPrintDocument([card], { mrn_no: mrn.mrn_no });
    const print_title = mrn.mrn_no ? `MRN No. ${mrn.mrn_no} — Batch QC` : "Batch QC Sticker";

    try {
      await insertCoilDownloadLog({
        coil_no_uid: null,
        mrn_no: mrn.mrn_no,
        heat_no: base.heat_no,
        item_code: base.item_code,
        acc_name: base.acc_name,
        downloaded_by: auditUserName(req),
        download_type: "batch_qc",
        sticker_count: 1,
        download_source: "mrn_sticker_render_batch_qc",
      });
    } catch (logErr) {
      console.error("[batch qc download log]", logErr?.message || logErr);
    }

    return res.json({ success: true, html, print_title, total: 1 });
  } catch (err) {
    console.error("renderBatchQcSticker Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Could not generate the batch QC sticker. Please try again." });
  }
};

/** Print / download all (or selected) coil stickers for an MRN.
 *  body.is_qc / sticker_kind=qc → all QC stickers (coil-wise PRINT ALL QC).
 */
export const renderBulkCoilStickers = async (req, res) => {
  try {
    const mrn_uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    const isQc = isQcRequest(req.body);
    let uids = req.body?.coil_no_uids;
    if (typeof uids === "string") {
      try { uids = JSON.parse(uids); } catch { uids = null; }
    }

    let coils = [];
    if (Array.isArray(uids) && uids.length) {
      for (const uid of uids) {
        const c = await findCoilByUid(String(uid).trim());
        if (c) coils.push(c);
      }
    } else if (mrn_uid) {
      const result = await findCoils({
        filters: { mrn_uid },
        limit: 5000,
        sortBy: "coil_index",
        order: "ASC",
      });
      coils = result.data || [];
    } else {
      return res.status(400).json({ success: false, message: "An MRN UID or at least one Coil UID is required." });
    }

    if (!coils.length) {
      return res.status(404).json({ success: false, message: "There are no coils to print." });
    }

    // Keep print order stable by coil_index when UIDs were supplied out of order.
    coils = [...coils].sort(
      (a, b) => (Number(a.coil_index) || 0) - (Number(b.coil_index) || 0)
    );

    const mrn = coils[0].mrn_uid ? await findMrnByUid(coils[0].mrn_uid) : null;
    const cards = [];
    for (const coil of coils) {
      const printRow = {
        ...mapCoilToStickerPrintRow(coil, mrn || {}),
        ...(isQc ? { is_qc: true, sticker_kind: "qc" } : {}),
      };
      cards.push(await buildCoilStickerCardHtml(printRow));
    }

    const mrnNo = coils[0].mrn_no ?? mrn?.mrn_no;
    const html = buildCoilStickerPrintDocument(cards, { mrn_no: mrnNo });
    const print_title = isQc
      ? (mrnNo ? `MRN No. ${mrnNo} — QC` : "QC Stickers")
      : buildCoilStickerPrintDocumentTitle(mrnNo);

    try {
      await insertCoilDownloadLog({
        coil_no_uid: null,
        mrn_no: mrnNo,
        heat_no: coils[0].heat_no,
        item_code: coils[0].item_code,
        acc_name: coils[0].acc_name,
        downloaded_by: auditUserName(req),
        download_type: isQc ? "bulk_qc" : "bulk",
        sticker_count: cards.length,
        download_source:
          String(req.body?.download_source || "").trim() ||
          (isQc ? "mrn_sticker_render_bulk_qc" : "mrn_sticker_render_bulk"),
      });
      await incrementCoilDownloadCount(coils.map((c) => c.coil_no_uid));
    } catch (logErr) {
      console.error("[coil download log bulk]", logErr?.message || logErr);
    }

    return res.json({
      success: true,
      html,
      print_title,
      total: cards.length,
    });
  } catch (err) {
    console.error("renderBulkCoilStickers Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Could not generate the coil stickers. Please try again." });
  }
};
