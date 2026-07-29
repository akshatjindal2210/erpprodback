/**
 * Stock Adjustment stickers — same IMS packing sticker (buildStickerCardHtml)
 * as FG Stock Adjustment / box print. Coil UID is printed as box_no_uid.
 */
import { findCoilByUid } from "../../coil/models/coil.model.js";
import { insertCoilDownloadLog } from "../../coil/models/coilDownloadLog.model.js";
import { incrementCoilDownloadCount } from "../../coil/models/coil.model.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import {
  buildStickerCardHtml,
  buildPrintDocument,
  buildStickerPrintDocumentTitle,
} from "../../../../core/lib/utils/helper/helper.js";

/** Map RM coil → IMS sticker card fields. */
export function mapSaCoilToImsStickerRow(coil = {}, meta = {}) {
  const uid = String(coil.coil_no_uid || "").trim();
  const qty = Number(coil.qty ?? 0);
  const packing =
    String(meta.packing_number || "").trim() ||
    (coil.sa_id != null ? `SA-${coil.sa_id}` : "") ||
    String(coil.heat_no || "").trim() ||
    uid ||
    "--";

  return {
    acc_name: coil.acc_name || meta.acc_name || "--",
    item_code: coil.item_code || meta.item_code || "--",
    itemdesc: coil.item_desc || meta.item_desc || "--",
    qty: Number.isFinite(qty) ? qty : 0,
    unit: String(coil.it_unit || meta.unit || "KG").trim() || "KG",
    packing_number: packing,
    package_no: packing,
    doc_dt: coil.created_at || meta.doc_dt || new Date(),
    job_no: coil.heat_no || meta.heat_no || "--",
    party_rate_cust_code: meta.party_rate_cust_code || null,
    box_no_uid: uid,
    box_uid: coil.coil_uid ?? null,
  };
}

export const renderSingleSaImsSticker = async (req, res) => {
  try {
    const coil_no_uid = String(req.body?.coil_no_uid || "").trim();
    if (!coil_no_uid) {
      return res.status(400).json({ success: false, message: "Coil UID is required." });
    }
    const coil = await findCoilByUid(coil_no_uid);
    if (!coil) return res.status(404).json({ success: false, message: "Coil not found." });

    const sticker_meta = req.body?.sticker_meta && typeof req.body.sticker_meta === "object"
      ? req.body.sticker_meta
      : {};
    const printRow = mapSaCoilToImsStickerRow(coil, sticker_meta);
    const card = await buildStickerCardHtml(printRow);
    const packingLabel = printRow.packing_number;
    const html = buildPrintDocument([card], { packing_number: packingLabel });
    const print_title = buildStickerPrintDocumentTitle(packingLabel);

    try {
      await insertCoilDownloadLog({
        coil_no_uid: coil.coil_no_uid,
        mrn_no: coil.mrn_no,
        heat_no: coil.heat_no,
        item_code: coil.item_code,
        acc_name: coil.acc_name,
        downloaded_by: auditUserName(req),
        download_type: "single",
        sticker_count: 1,
        download_source:
          String(req.body?.download_source || "").trim() || "stock_adjustment",
      });
      await incrementCoilDownloadCount([coil.coil_no_uid]);
    } catch (logErr) {
      console.error("[SA IMS sticker download log]", logErr?.message || logErr);
    }

    return res.json({ success: true, html, print_title });
  } catch (err) {
    console.error("renderSingleSaImsSticker Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Could not generate the sticker. Please try again." });
  }
};

export const renderBulkSaImsStickers = async (req, res) => {
  try {
    const raw = req.body?.coil_no_uids ?? req.body?.uids ?? [];
    const uids = Array.isArray(raw)
      ? [...new Set(raw.map((u) => String(u || "").trim()).filter(Boolean))]
      : [];
    if (!uids.length) {
      return res.status(400).json({ success: false, message: "At least one Coil UID is required." });
    }

    const sticker_meta = req.body?.sticker_meta && typeof req.body.sticker_meta === "object"
      ? req.body.sticker_meta
      : {};

    const cards = [];
    const foundUids = [];
    let packingLabel = String(sticker_meta.packing_number || "").trim();

    for (const uid of uids) {
      const coil = await findCoilByUid(uid);
      if (!coil) continue;
      const printRow = mapSaCoilToImsStickerRow(coil, sticker_meta);
      if (!packingLabel) packingLabel = printRow.packing_number;
      cards.push(await buildStickerCardHtml(printRow));
      foundUids.push(coil.coil_no_uid);
    }

    if (!cards.length) {
      return res.status(404).json({ success: false, message: "No coils were found to print." });
    }

    const html = buildPrintDocument(cards, { packing_number: packingLabel });
    const print_title = buildStickerPrintDocumentTitle(packingLabel);

    try {
      for (const uid of foundUids) {
        const coil = await findCoilByUid(uid);
        if (!coil) continue;
        await insertCoilDownloadLog({
          coil_no_uid: coil.coil_no_uid,
          mrn_no: coil.mrn_no,
          heat_no: coil.heat_no,
          item_code: coil.item_code,
          acc_name: coil.acc_name,
          downloaded_by: auditUserName(req),
          download_type: "bulk",
          sticker_count: 1,
          download_source:
            String(req.body?.download_source || "").trim() || "stock_adjustment",
        });
      }
      await incrementCoilDownloadCount(foundUids);
    } catch (logErr) {
      console.error("[SA IMS sticker bulk download log]", logErr?.message || logErr);
    }

    return res.json({ success: true, html, print_title, count: cards.length });
  } catch (err) {
    console.error("renderBulkSaImsStickers Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Could not generate the stickers. Please try again." });
  }
};
