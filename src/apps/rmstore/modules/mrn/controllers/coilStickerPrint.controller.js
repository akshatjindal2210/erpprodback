/**
 * MRN sticker print/preview.
 *
 * Flow: route (mrn.routes) → this controller → coil/mrn models → coilStickerDesign
 * HTML/layout changes → only coilStickerDesign.js (LAYOUT)
 */
import { resolveMrnForSticker } from "../utils/resolveMrnForSticker.js";
import { findCoilByUid, findCoils, incrementCoilDownloadCount } from "../../coil/models/coil.model.js";
import { formatCoilNoUid } from "../../../lib/coilUidFormat.js";
import { insertCoilDownloadLog } from "../../coil/models/coilDownloadLog.model.js";
import { getBoxNoUidPrefix } from "../../../../core/configuration/models/appConfig.model.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { buildStickerDocs, buildStickerPrintTitle, rmStickerSize } from "../../../lib/sticker/coilStickerDesign.js";
import { splitQtyAcrossCoils } from "./mrnSticker.controller.js";

function isQc(body = {}) {
  if (body?.is_qc === true || body?.is_qc === 1) return true;
  const v = String(body?.is_qc ?? "").trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  return String(body?.sticker_kind || "").trim().toLowerCase() === "qc";
}

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

async function loadCoilsForMrn(mrn_uid) {
  const result = await findCoils({
    filters: { mrn_uid },
    limit: 5000,
    sortBy: "coil_index",
    order: "ASC",
  });
  return result.data || [];
}

async function logDownload(payload) {
  try {
    await insertCoilDownloadLog(payload);
    if (payload.coil_uids?.length) await incrementCoilDownloadCount(payload.coil_uids);
  } catch (e) {
    console.error("[rm sticker download log]", e?.message || e);
  }
}

/** POST /mrn/sticker/preview — layout before generate (coil #1 sample). */
export const previewCoilSticker = async (req, res) => {
  try {
    const body = req.body || {};
    const coil_count = Math.max(1, Number(body.coil_count) || 1);
    let total_qty = Number(body.total_qty ?? body.it_recp_qty ?? body.itrecpqty);
    if (!Number.isFinite(total_qty) || total_qty < 0) {
      return fail(res, 400, "A valid total quantity is required.");
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

    const mrn_no = body.mrn_no ?? body.mrnno ?? null;
    const serial_no = body.serial_no ?? body.itsrno ?? null;
    // Preview payload often has uid on detail; fall back to mrn_no_serial when missing.
    const mrn_uid = String(body.uid ?? body.mrn_uid ?? "").trim() || (mrn_no != null && serial_no != null && String(serial_no).trim() !== "" ? `${String(mrn_no).trim()}_${String(serial_no).trim()}` : null);
    const heat_no = body.heat_no != null ? String(body.heat_no).trim() : "";

    const sampleCoil = {
      coil_no_uid: formatCoilNoUid({
        prefix: await getBoxNoUidPrefix(),
        mrn_no,
        serial_no,
        total: coil_count,
        index: 1,
      }),
      qty: coil_qtys[0] ?? 0,
      heat_no: heat_no || null,
      item_dcode: body.item_dcode ?? body.itemdcode ?? null,
      item_code: body.item_code ?? body.itemcode,
      item_desc: body.item_desc ?? body.itemdesc,
      acc_name: body.acc_name,
      mrn_no,
      mrn_uid,
      mrn_dt: body.mrn_dt ?? body.mrndt,
      it_unit: body.it_unit ?? body.itunit ?? "PCS",
    };
    const mrn = {
      uid: mrn_uid,
      mrn_no,
      mrn_dt: sampleCoil.mrn_dt,
      acc_name: sampleCoil.acc_name,
      item_dcode: sampleCoil.item_dcode,
      item_code: sampleCoil.item_code,
      item_desc: sampleCoil.item_desc,
      it_unit: sampleCoil.it_unit,
      it_lot_no: body.it_lot_no ?? body.itLotNo,
    };

    const doc = await buildStickerDocs(sampleCoil, mrn, {
      isQc: isQc(body),
      createdBy: auditUserName(req),
      preview: true,
    });

    return res.json({
      success: true,
      html: doc.html,
      ...rmStickerSize(),
      sample_coil_no_uid: sampleCoil.coil_no_uid,
      total_stickers: coil_count,
      message: "Coil sticker preview is ready.",
    });
  } catch (err) {
    console.error("previewCoilSticker:", err);
    return fail(res, 500, err.message || "Could not generate the sticker preview. Please try again.");
  }
};

/** POST /mrn/sticker/render-single — one coil (or QC). */
export const renderSingleCoilSticker = async (req, res) => {
  try {
    const coil_no_uid = String(req.body?.coil_no_uid || "").trim();
    if (!coil_no_uid) return fail(res, 400, "Coil UID is required.");

    const qc = isQc(req.body);
    const coil = await findCoilByUid(coil_no_uid);
    if (!coil) return fail(res, 404, "Coil not found.");

    const mrn = coil.mrn_uid ? (await resolveMrnForSticker(coil.mrn_uid)).mrn : null;
    const doc = await buildStickerDocs(coil, mrn || {}, {
      isQc: qc,
      createdBy: coil.created_by || auditUserName(req),
    });

    await logDownload({
      coil_no_uid: coil.coil_no_uid,
      mrn_uid: coil.mrn_uid,
      mrn_no: coil.mrn_no,
      heat_no: coil.heat_no,
      item_code: coil.item_code,
      acc_name: coil.acc_name || mrn?.acc_name || null,
      downloaded_by_id: req.user?.id,
      downloaded_by: auditUserName(req),
      download_type: qc ? "qc" : "single",
      sticker_count: 1,
      download_source:
        String(req.body?.download_source || "").trim() ||
        (qc ? "mrn_sticker_render_qc" : "mrn_sticker_render"),
      coil_uids: [coil.coil_no_uid],
    });

    return res.json({ success: true, html: doc.html, print_title: doc.print_title });
  } catch (err) {
    console.error("renderSingleCoilSticker:", err);
    return fail(res, 500, err.message || "Could not generate the coil sticker. Please try again.");
  }
};

/** POST /mrn/sticker/render-batch-qc — one QC sticker for whole MRN batch. */
export const renderBatchQcSticker = async (req, res) => {
  try {
    const mrn_uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!mrn_uid) return fail(res, 400, "MRN UID is required.");

    const { mrn, mrn_uid: lookupUid } = await resolveMrnForSticker(mrn_uid);
    const uid = lookupUid || mrn_uid;
    if (!mrn) return fail(res, 404, "MRN not found.");

    const coils = await loadCoilsForMrn(uid);
    if (!coils.length) return fail(res, 404, "No coils were found for this batch.");

    const base = coils[0];
    const batchCoil = {
      ...base,
      qty: coils.reduce((s, c) => s + (Number(c.qty) || 0), 0),
      mrn_uid: base.mrn_uid ?? uid,
      coil_no_uid: `${String(mrn_uid).trim()}_batch_qc`,
      total_coils: coils.length,
    };

    const doc = await buildStickerDocs(batchCoil, mrn, {
      isQc: true,
      createdBy: base.created_by || auditUserName(req),
    });

    await logDownload({
      coil_no_uid: null,
      mrn_uid: uid,
      mrn_no: mrn.mrn_no,
      heat_no: base.heat_no,
      item_code: base.item_code,
      acc_name: base.acc_name || mrn.acc_name || null,
      downloaded_by_id: req.user?.id,
      downloaded_by: auditUserName(req),
      download_type: "batch_qc",
      sticker_count: 1,
      download_source: "mrn_sticker_render_batch_qc",
    });

    return res.json({
      success: true,
      html: doc.html,
      print_title: buildStickerPrintTitle(mrn.mrn_no, { isQc: true, batch: true }),
      total: 1,
    });
  } catch (err) {
    console.error("renderBatchQcSticker:", err);
    return fail(res, 500, err.message || "Could not generate the batch QC sticker. Please try again.");
  }
};

/** POST /mrn/sticker/render-bulk — all / selected coils (optional is_qc). */
export const renderBulkCoilStickers = async (req, res) => {
  try {
    const mrn_uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    const qc = isQc(req.body);
    let uids = req.body?.coil_no_uids;
    if (typeof uids === "string") {
      try { uids = JSON.parse(uids); } catch { uids = null; }
    }

    let coils = [];
    if (Array.isArray(uids) && uids.length) {
      for (const id of uids) {
        const c = await findCoilByUid(String(id).trim());
        if (c) coils.push(c);
      }
    } else if (mrn_uid) {
      coils = await loadCoilsForMrn(mrn_uid);
    } else {
      return fail(res, 400, "An MRN UID or at least one Coil UID is required.");
    }

    if (!coils.length) return fail(res, 404, "There are no coils to print.");
    coils = [...coils].sort((a, b) => (Number(a.coil_index) || 0) - (Number(b.coil_index) || 0));

    const mrn = coils[0].mrn_uid ? (await resolveMrnForSticker(coils[0].mrn_uid)).mrn : null;
    const doc = await buildStickerDocs(coils, mrn || {}, {
      isQc: qc,
      createdBy: auditUserName(req),
    });

    await logDownload({
      coil_no_uid: null,
      mrn_uid: mrn_uid || coils[0]?.mrn_uid,
      mrn_no: doc.mrn_no,
      heat_no: coils[0].heat_no,
      item_code: coils[0].item_code,
      acc_name: coils[0].acc_name || mrn?.acc_name || null,
      downloaded_by_id: req.user?.id,
      downloaded_by: auditUserName(req),
      download_type: qc ? "bulk_qc" : "bulk",
      sticker_count: doc.total,
      download_source:
        String(req.body?.download_source || "").trim() ||
        (qc ? "mrn_sticker_render_bulk_qc" : "mrn_sticker_render_bulk"),
      coil_uids: coils.map((c) => c.coil_no_uid),
    });

    return res.json({
      success: true,
      html: doc.html,
      print_title: doc.print_title,
      total: doc.total,
    });
  } catch (err) {
    console.error("renderBulkCoilStickers:", err);
    return fail(res, 500, err.message || "Could not generate the coil stickers. Please try again.");
  }
};
