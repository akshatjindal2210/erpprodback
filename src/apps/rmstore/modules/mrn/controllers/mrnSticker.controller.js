import { findMrnByUid, insertMrn, setMrnStickerGenerated, setMrnStickerApproved, setMrnStickerRejected, hardDeleteMrnByUid, updateMrnDocs, updateMrnStickerMeta, saveMrnStickerDraft } from "../models/mrn.model.js";
import { findQcRejection, insertQcRejection, updateQcRejection, hasApprovedRejectionStoreOut, isMrnPortalRejectionRow, permanentlyRemoveUnusedMrnPortalRejection, MRN_PORTAL_REJECTION_REASON } from "../../rm-rejection/models/rmRejection.model.js";
import { findOutEntry } from "../../out-entry/models/outEntry.model.js";
import { isSuperAdminUser } from "../../../lib/utils/rmstoreSpecialPermissions.js";
import { applyApprovalWorkflow } from "../../../../core/lib/utils/auth/approval.js";
import { resolveMrnForSticker } from "../utils/resolveMrnForSticker.js";
import { countCoilsForMrn, insertBulkCoils, findCoils, softDeleteCoilsByCoilNoUids } from "../../coil/models/coil.model.js";
import { formatCoilNoUid } from "../../../lib/coilUidFormat.js";
import { computeMrnQtyBudget } from "../../stock-adjustment/utils/mrnQtyBudget.js";
import { softDeleteQcChecksByCoilNoUids } from "../../qc-check/models/qcCheck.model.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { getBoxNoUidPrefix, getMrnCoilQtyEditable, getMrnCoilQtyAutoCalc, getMrnStickerMode } from "../../../../core/configuration/models/appConfig.model.js";
import { MRN_STICKER_REQUIRE_SPEC } from "../../../lib/config/app.config.js";
import { findSpecItemDetail } from "../../spec/models/specMaster.model.js";
import { logRmstoreActivity } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { toRmPublicUploadPath } from "../../../lib/middleware/upload.js";
import { splitQtyAcrossCoils, equalSplitQtyAcrossCoils } from "../../../lib/utils/coilQtySplit.js";
export { splitQtyAcrossCoils, equalSplitQtyAcrossCoils };

const MODULE = "rm_mrn_portal";
const QTY_EPS = 0.001;

const log = (req, action, entity_id, details, record = null) =>
  logRmstoreActivity(req, { action, entity: MODULE, entity_id, details, record }).catch(() => {});

function mapBodyToMrn(body = {}) {
  const userc = body.internal_create_user ?? body.userc ?? body.Userc ?? null;
  const datec = body.internal_create_date ?? body.datec ?? body.Datec ?? null;
  return {
    uid: body.uid != null ? String(body.uid) : null,
    mrn_no: body.mrnno ?? body.mrn_no ?? null,
    serial_no: body.itsrno ?? body.serial_no ?? null,
    mrn_dt: body.mrndt ?? body.mrn_dt ?? null,
    bill_no: body.billno ?? body.bill_no ?? null,
    bill_dt: body.billdt ?? body.bill_dt ?? null,
    acc_code: body.acc_code ?? null,
    acc_name: body.acc_name ?? null,
    item_dcode: body.itemdcode ?? body.item_dcode ?? null,
    item_code: body.itemcode ?? body.item_code ?? null,
    item_desc: body.itemdesc ?? body.item_desc ?? null,
    it_recp_qty: body.itrecpqty ?? body.it_recp_qty ?? null,
    it_lot_no: body.itLotNo ?? body.itlotno ?? body.it_lot_no ?? null,
    it_unit: body.itunit ?? body.it_unit ?? null,
    fyid: body.fyid ?? null,
    internal_create_user: userc != null && String(userc).trim() !== "" ? String(userc).trim() : null,
    internal_create_date: datec != null && String(datec).trim() !== "" ? String(datec).trim() : null,
  };
}

function parseCoilQtys(body, coil_count) {
  let raw = body?.coil_qtys ?? body?.coils ?? null;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw) || raw.length !== coil_count) return null;
  const qtys = raw.map((c) => {
    if (c != null && typeof c === "object") return Number(c.qty);
    return Number(c);
  });
  if (qtys.some((q) => !Number.isFinite(q) || q < 0)) return null;
  return qtys.map((q) => Math.round(q));
}

function round3(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v);
}

function parseDraftObj(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? raw : null;
}

/** Resolve MRN row: existing uid, or create from ERP payload at Generate time. */
async function resolveMrnForGenerate(req) {
  const uid = req.body?.uid != null ? String(req.body.uid).trim() : "";
  if (!uid) {
    return { error: { status: 400, message: "MRN UID is required." } };
  }

  const existing = await findMrnByUid(uid);
  if (existing) return { mrn: existing };

  const source = mapBodyToMrn(req.body);
  source.uid = uid;
  if (!source.mrn_no && !source.item_dcode) {
    return { error: { status: 400, message: "The MRN details are incomplete. Provide the ERP details or an existing MRN UID." } };
  }

  const mrn = await insertMrn({
    ...source,
    sticker_generated: false,
  });
  return { mrn, created: true };
}

/** MRN + existing coil stickers. */
export const getMrnDetail = async (req, res) => {
  try {
    const uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!uid) return res.status(400).json({ success: false, message: "MRN UID is required." });
    const resolved = await resolveMrnForSticker(uid, { allowErp: true });
    const mrn = resolved.mrn;
    const mrn_uid = resolved.mrn_uid || uid;
    if (!mrn) return res.status(404).json({ success: false, message: "MRN not found." });
    const coils = await findCoils({
      filters: { mrn_uid, source: "MRN PORTAL" },
      limit: 5000,
      sortBy: "coil_index",
      order: "ASC",
    });
    const [qty_editable, qty_auto_calc, sticker_mode] = await Promise.all([
      getMrnCoilQtyEditable(),
      getMrnCoilQtyAutoCalc(),
      getMrnStickerMode(),
    ]);
    return res.json({
      success: true,
      data: {
        ...mrn,
        userc: mrn.internal_create_user ?? null,
        datec: mrn.internal_create_date ?? null,
        coils: coils.data || [],
        sticker_generated: !!mrn.sticker_generated,
        sticker_approved: mrn.sticker_approved === true || (mrn.sticker_generated && mrn.sticker_approved !== false),
        sticker_approved_by: mrn.sticker_approved_by ?? null,
        sticker_approved_at: mrn.sticker_approved_at ?? null,
        sticker_rejected: mrn.sticker_rejected === true,
        status: mrn.sticker_rejected
          ? "reject"
          : !mrn.sticker_generated
            ? "pending"
            : mrn.sticker_approved === false
              ? "generate"
              : "approved",
        sticker_draft: parseDraftObj(mrn.sticker_draft) ?? mrn.sticker_draft ?? null,
        has_sticker_draft: !!parseDraftObj(mrn.sticker_draft),
        coil_count: (coils.data || []).length,
        qty_editable,
        qty_auto_calc,
        // Master-level mode only. Legacy generated rows with null mode were coil-wise.
        sticker_mode: mrn?.sticker_mode || (mrn?.sticker_generated ? "coil" : sticker_mode),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Generate coil stickers — same sticker_generated flow as IMS packing stickers.
 */
export const generateMrnStickers = async (req, res) => {
  try {
    const heat_no = String(req.body?.heat_no || "").trim();
    if (!heat_no) {
      return res.status(400).json({ success: false, message: "Heat number is required." });
    }
    const coil_count = Number(req.body?.coil_count);
    if (!Number.isFinite(coil_count) || coil_count < 1) {
      return res.status(400).json({ success: false, message: "The number of coils must be at least 1." });
    }

    const resolved = await resolveMrnForGenerate(req);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }
    const mrn = resolved.mrn;
    const uid = String(mrn.uid);

    if (mrn.sticker_rejected) {
      return res.status(409).json({
        success: false,
        message: "This MRN has been rejected and cannot generate stickers.",
      });
    }

    if (mrn.sticker_generated || (await countCoilsForMrn(uid)) > 0) {
      return res.status(409).json({
        success: false,
        message: "Stickers have already been generated for this MRN.",
      });
    }

    const preBudget = await computeMrnQtyBudget(uid, { receiptQty: mrn.it_recp_qty });
    if (preBudget.remaining_qty <= QTY_EPS) {
      return res.status(400).json({
        success: false,
        message: `MRN receipt qty (${preBudget.receipt_qty} KG) is fully allocated — reduce or remove existing coils / stock adjustments before generating stickers.`,
      });
    }

    // Permanent product rule — see MRN_STICKER_REQUIRE_SPEC in rmstore app.config.
    if (MRN_STICKER_REQUIRE_SPEC) {
      const itemDcode = Number(mrn.item_dcode);
      if (!Number.isFinite(itemDcode) || itemDcode <= 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot generate stickers because the RM item is missing on this MRN. Add the item and create RM Spec Master first.",
        });
      }
      const specDetail = await findSpecItemDetail(itemDcode);
      if (!specDetail) {
        return res.status(400).json({
          success: false,
          message: `Cannot generate stickers because no RM Spec Master exists for item ${mrn.item_desc || mrn.item_code}. Create the specifications first.`,
        });
      }
      if (specDetail.approved !== true) {
        return res.status(400).json({
          success: false,
          message: `Cannot generate stickers because RM specifications for item ${mrn.item_desc || mrn.item_code} exist but are not authorized. Approve all spec lines first.`,
        });
      }
    }

    const originalQty = Number(mrn.it_recp_qty);
    const [qtyEditable, qtyAutoCalc, stickerMode] = await Promise.all([
      getMrnCoilQtyEditable(),
      getMrnCoilQtyAutoCalc(),
      getMrnStickerMode(),
    ]);

    let total_qty;
    let coil_qtys;

    if (!qtyEditable) {
      // Locked: receipt qty; auto-on = uneven wave, auto-off = equal per coil.
      total_qty = round3(originalQty);
      if (!Number.isFinite(total_qty) || total_qty < 0) {
        return res.status(400).json({ success: false, message: "The MRN receipt quantity is invalid." });
      }
      coil_qtys = qtyAutoCalc
        ? splitQtyAcrossCoils(total_qty, coil_count)
        : equalSplitQtyAcrossCoils(total_qty, coil_count);
    } else if (!qtyAutoCalc) {
      // Manual: client must supply coil_qtys (and total).
      total_qty = req.body?.total_qty != null && req.body.total_qty !== ""
        ? Number(req.body.total_qty)
        : originalQty;
      if (!Number.isFinite(total_qty) || total_qty < 0) {
        return res.status(400).json({ success: false, message: "Total quantity must be a valid number." });
      }
      total_qty = round3(total_qty);
      coil_qtys = parseCoilQtys(req.body, coil_count);
      if (!coil_qtys) {
        return res.status(400).json({
          success: false,
          message: "Auto-calculation is turned off, so enter the quantity for each coil manually.",
        });
      }
    } else {
      // Auto on + editable: prefer client qtys, else system split.
      total_qty = req.body?.total_qty != null && req.body.total_qty !== ""
        ? Number(req.body.total_qty)
        : originalQty;
      if (!Number.isFinite(total_qty) || total_qty < 0) {
        return res.status(400).json({ success: false, message: "Total quantity must be a valid number." });
      }
      total_qty = round3(total_qty);
      coil_qtys = parseCoilQtys(req.body, coil_count);
      if (!coil_qtys) {
        coil_qtys = splitQtyAcrossCoils(total_qty, coil_count);
      }
    }

    const sumQtys = round3(coil_qtys.reduce((s, q) => s + Number(q), 0));
    if (Math.abs(sumQtys - total_qty) > QTY_EPS) {
      return res.status(400).json({
        success: false,
        message: `The coil quantities add up to ${sumQtys} but must equal the total of ${total_qty}. Adjust the quantities so the total matches.`,
      });
    }
    if (coil_qtys.some((q) => !Number.isFinite(Number(q)) || Number(q) < 1)) {
      return res.status(400).json({
        success: false,
        message: "Each coil quantity must be at least 1. Zero quantity coils are not allowed.",
      });
    }

    const postBudget = await computeMrnQtyBudget(uid, { receiptQty: originalQty });
    if (total_qty > postBudget.remaining_qty + QTY_EPS) {
      return res.status(400).json({
        success: false,
        message: `Total qty (${total_qty} KG) exceeds remaining MRN receipt (${postBudget.remaining_qty} of ${postBudget.receipt_qty} KG).`,
      });
    }

    const remarks = req.body?.remarks != null ? String(req.body.remarks).trim() : null;
    const user = auditUserName(req);
    const stickerPrefix = await getBoxNoUidPrefix();
    const generateAt = new Date().toISOString();

    const rows = [];
    for (let i = 1; i <= coil_count; i++) {
      rows.push({
        coil_no_uid: formatCoilNoUid({
          prefix: stickerPrefix,
          mrn_no: mrn.mrn_no,
          serial_no: mrn.serial_no,
          total: coil_count,
          index: i,
        }),
        mrn_uid: uid,
        mrn_no: mrn.mrn_no,
        serial_no: mrn.serial_no,
        heat_no,
        item_dcode: mrn.item_dcode,
        item_code: mrn.item_code,
        item_desc: mrn.item_desc,
        acc_code: mrn.acc_code,
        acc_name: mrn.acc_name,
        qty: round3(coil_qtys[i - 1]),
        remarks,
        created_by: user,
      });
    }

    let created = [];
    try {
      created = await insertBulkCoils(rows);
      await updateMrnStickerMeta(uid, { heat_no, remarks });
      await setMrnStickerGenerated(uid, { user, at: generateAt, sticker_mode: stickerMode });
    } catch (err) {
      if (created.length) {
        try {
          const coilUids = created.map((c) => c.coil_no_uid);
          await softDeleteQcChecksByCoilNoUids(coilUids, user);
          await softDeleteCoilsByCoilNoUids(coilUids, user);
        } catch {
          /* ignore cleanup errors */
        }
      }
      throw err;
    }

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.STICKER_CREATE,
      source_module: "mrn_portal",
      source_id: uid,
      mrn_no: mrn.mrn_no,
      user_name: user,
      user_id: req.user?.id,
      rows: created,
      details: {
        mrn_uid: uid,
        heat_no,
        item_code: mrn.item_code,
        coil_count: created.length,
        total_qty,
        sticker_mode: stickerMode,
      },
    });

    await log(req, "generate", uid, {
      uid,
      heat_no,
      coil_count,
      total_qty,
      sticker_mode: stickerMode,
      qty_editable: qtyEditable,
      qty_auto_calc: qtyAutoCalc,
    }, { uid, sticker_generated: true });

    return res.status(201).json({
      success: true,
      data: {
        uid,
        sticker_generated: true,
        coils: created,
        sticker_mode: stickerMode,
        breakdown: {
          item_code: mrn.item_code,
          item_desc: mrn.item_desc,
          heat_no,
          coil_count,
          total_qty,
          total_stickers: coil_count,
          sticker_mode: stickerMode,
          uid_format: "prefix_mrnno_serialno_totalno_colino",
        },
      },
      message: `${created.length} coil sticker(s) generated successfully.`,
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: "A duplicate Coil UID was found. Stickers may already exist for this MRN." });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Save in-progress sticker form without creating coils. */
export const saveMrnStickerDraftCtrl = async (req, res) => {
  try {
    const resolved = await resolveMrnForGenerate(req);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }
    const mrn = resolved.mrn;
    const uid = String(mrn.uid);

    if (mrn.sticker_rejected) {
      return res.status(409).json({
        success: false,
        message: "This MRN has been rejected and cannot save a sticker draft.",
      });
    }

    if (mrn.sticker_generated || (await countCoilsForMrn(uid)) > 0) {
      return res.status(409).json({
        success: false,
        message: "Stickers have already been generated for this MRN.",
      });
    }

    const coil_count = Math.max(1, Number(req.body?.coil_count) || 1);
    let coil_qtys = parseCoilQtys(req.body, coil_count);
    if (!coil_qtys && Array.isArray(req.body?.coil_qtys)) {
      coil_qtys = req.body.coil_qtys.map((q) => round3(Number(q)));
    }
    const total_qty =
      req.body?.total_qty != null && req.body.total_qty !== ""
        ? round3(Number(req.body.total_qty))
        : round3(Number(mrn.it_recp_qty));

    const draft = {
      heat_no: req.body?.heat_no != null ? String(req.body.heat_no).trim() : "",
      coil_count,
      coil_qtys: coil_qtys || [],
      total_qty: Number.isFinite(total_qty) ? total_qty : null,
      remarks: req.body?.remarks != null ? String(req.body.remarks).trim() : "",
    };

    const user = auditUserName(req);
    const saved = await saveMrnStickerDraft(uid, { draft, user, at: new Date().toISOString() });
    await updateMrnStickerMeta(uid, {
      heat_no: draft.heat_no || null,
      remarks: draft.remarks || "",
    });

    const docMerge = await mergeMrnDocUploads(req, uid, { requireBoth: false });
    if (docMerge.error) {
      return res.status(docMerge.error.status).json({ success: false, message: docMerge.error.message });
    }
    const finalMrn = docMerge.mrn ?? saved ?? mrn;

    await log(req, "save_draft", uid, {
      uid,
      mrn_no: mrn.mrn_no,
      serial_no: mrn.serial_no,
      item_code: mrn.item_code,
      item_desc: mrn.item_desc,
      heat_no: draft.heat_no || null,
      coil_count: draft.coil_count,
      total_qty: draft.total_qty,
      coil_qtys: draft.coil_qtys,
      remarks: draft.remarks || null,
      tc_file_name: finalMrn?.tc_file_name ?? null,
      rmtc_file_name: finalMrn?.rmtc_file_name ?? null,
      uploaded_tc: !!req.files?.tc?.[0],
      uploaded_rmtc: !!req.files?.rmtc?.[0],
      created_mrn_row: !!resolved.created,
    }, finalMrn);

    return res.json({
      success: true,
      data: {
        uid,
        sticker_draft: draft,
        has_sticker_draft: true,
        sticker_draft_at: finalMrn?.sticker_draft_at ?? saved?.sticker_draft_at ?? null,
        sticker_draft_by: finalMrn?.sticker_draft_by ?? saved?.sticker_draft_by ?? null,
        tc_file_path: finalMrn?.tc_file_path ?? null,
        tc_file_name: finalMrn?.tc_file_name ?? null,
        rmtc_file_path: finalMrn?.rmtc_file_path ?? null,
        rmtc_file_name: finalMrn?.rmtc_file_name ?? null,
      },
      toast_type: "success",
      message: "Sticker draft saved successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getMrnCoils = async (req, res) => {
  try {
    const uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!uid) return res.status(400).json({ success: false, message: "MRN UID is required." });
    const heat_no = req.body?.heat_no != null ? String(req.body.heat_no).trim() : "";
    const result = await findCoils({
      filters: { mrn_uid: uid, source: "MRN PORTAL", ...(heat_no ? { heat_no } : {}) },
      limit: 5000,
      sortBy: "coil_uid",
      order: "ASC",
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Merge optional TC/RMTC uploads onto the MRN row (keeps existing files when omitted). */
async function mergeMrnDocUploads(req, uid, { requireBoth = false } = {}) {
  const key = String(uid || "").trim();
  if (!key) return { error: { status: 400, message: "MRN UID is required." } };

  const resolved = await resolveMrnForSticker(key);
  const mrn = resolved.mrn;
  if (!mrn) return { error: { status: 404, message: "MRN not found." } };

  const tcFile = req.files?.tc?.[0] || null;
  const rmtcFile = req.files?.rmtc?.[0] || null;

  if (requireBoth && (!tcFile || !rmtcFile)) {
    return {
      error: {
        status: 400,
        message: "Both the TC and RMTC documents are required.",
      },
    };
  }
  if (!tcFile && !rmtcFile) {
    return { mrn, docs: null };
  }

  const docs = {};
  if (tcFile) {
    docs.tc_file_path = toRmPublicUploadPath(tcFile, "tc");
    docs.tc_file_name = tcFile.originalname;
  }
  if (rmtcFile) {
    docs.rmtc_file_path = toRmPublicUploadPath(rmtcFile, "rmtc");
    docs.rmtc_file_name = rmtcFile.originalname;
  }

  const updated = await updateMrnDocs(key, docs);
  return { mrn: updated ?? mrn, docs };
}

function mrnHasBothDocs(mrn) {
  return Boolean(String(mrn?.tc_file_path || "").trim() && String(mrn?.rmtc_file_path || "").trim());
}

function parseUidList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v || "").trim()).filter(Boolean);
    } catch {
      // continue
    }
    return raw.split(/[,|]+/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

export const approveMrnStickers = async (req, res) => {
  try {
    const canApprove = isSuperAdminUser(req.user) || Boolean(req?.permission?.can_authorize) || String(req?.user?.type || req?.user?.role || "").toLowerCase() === "super_admin";
    if (!canApprove) {
      return res.status(403).json({ success: false, message: "You do not have permission to approve stickers." });
    }

    const uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!uid) return res.status(400).json({ success: false, message: "MRN UID is required." });

    const mrn = await findMrnByUid(uid);
    if (!mrn) return res.status(404).json({ success: false, message: "MRN not found." });
    if (!mrn.sticker_generated) {
      return res.status(400).json({ success: false, message: "Stickers have not been generated for this MRN." });
    }
    if (mrn.sticker_approved === true) {
      return res.status(409).json({ success: false, message: "Stickers are already approved for this MRN." });
    }

    const coils = await findCoils({
      filters: { mrn_uid: uid, source: "MRN PORTAL" },
      limit: 5000,
      sortBy: "coil_index",
      order: "ASC",
    });
    const coilRows = coils.data || [];
    if (!coilRows.length) {
      return res.status(400).json({ success: false, message: "No generated coils were found for this MRN." });
    }

    const scannedCoils = parseUidList(req.body?.scanned_coils ?? req.body?.scannedCoils);
    const scannedQc = parseUidList(req.body?.scanned_qc ?? req.body?.scannedQc);
    const scannedBatchQc = req.body?.scanned_batch_qc === true || req.body?.scannedBatchQc === true;
    const stickerMode = String(mrn.sticker_mode || "coil").toLowerCase() === "batch" ? "batch" : "coil";
    const expectedCoils = coilRows.map((c) => String(c.coil_no_uid || "").trim()).filter(Boolean);
    const coilSet = new Set(scannedCoils.map((v) => v.toLowerCase()));

    if (expectedCoils.some((c) => !coilSet.has(c.toLowerCase()))) {
      return res.status(400).json({
        success: false,
        message: "All coil stickers must be scanned before approval.",
      });
    }

    if (stickerMode === "batch") {
      if (!scannedBatchQc) {
        return res.status(400).json({
          success: false,
          message: "Batch QC sticker must be scanned before approval.",
        });
      }
    } else if (expectedCoils.some((c) => !scannedQc.map((v) => v.toLowerCase()).includes(c.toLowerCase()))) {
      return res.status(400).json({
        success: false,
        message: "All QC stickers must be scanned before approval.",
      });
    }

    const user = auditUserName(req);
    const approved = await setMrnStickerApproved(uid, { user, at: new Date().toISOString() });
    if (!approved) {
      return res.status(500).json({ success: false, message: "Could not approve stickers for this MRN." });
    }

    await log(req, "approve", uid, {
      uid,
      coil_count: expectedCoils.length,
      sticker_mode: stickerMode,
    }, approved);

    return res.json({
      success: true,
      data: {
        uid,
        sticker_approved: true,
        sticker_approved_by: approved.sticker_approved_by ?? user,
        sticker_approved_at: approved.sticker_approved_at ?? null,
        status: "approved",
      },
      message: "Stickers approved successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const rejectMrnPortal = async (req, res) => {
  try {
    const canReject = isSuperAdminUser(req.user) || Boolean(req?.permission?.can_authorize) || String(req?.user?.type || req?.user?.role || "").toLowerCase() === "super_admin";
    if (!canReject) {
      return res.status(403).json({ success: false, message: "You do not have permission to reject this MRN." });
    }

    const uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!uid) return res.status(400).json({ success: false, message: "MRN UID is required." });

    const remarks = req.body?.remarks != null ? String(req.body.remarks).trim() : "";
    if (!remarks) {
      return res.status(400).json({ success: false, message: "Remark is required." });
    }

    const resolved = await resolveMrnForGenerate(req);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }
    const mrn = resolved.mrn;
    if (mrn.sticker_generated || (await countCoilsForMrn(uid)) > 0) {
      return res.status(400).json({
        success: false,
        message: "Reject is only allowed before sticker generation.",
      });
    }
    if (mrn.sticker_rejected) {
      return res.status(409).json({ success: false, message: "This MRN has already been rejected." });
    }

    const draft = parseDraftObj(mrn.sticker_draft);
    let coil_count = Number(req.body?.coil_count);
    if (!Number.isFinite(coil_count) || coil_count < 1) {
      coil_count = draft?.coil_count != null ? Math.max(1, Number(draft.coil_count) || 1) : 1;
    }

    const total_qty =
      req.body?.total_qty != null && req.body.total_qty !== ""
        ? round3(Number(req.body.total_qty))
        : draft?.total_qty != null && draft.total_qty !== ""
          ? round3(Number(draft.total_qty))
          : round3(Number(mrn.it_recp_qty));

    let coil_qtys = parseCoilQtys(req.body, coil_count);
    if (!coil_qtys && Array.isArray(draft?.coil_qtys) && draft.coil_qtys.length === coil_count) {
      coil_qtys = draft.coil_qtys.map((q) => round3(Number(q)));
    }
    if (!coil_qtys) {
      coil_qtys = splitQtyAcrossCoils(total_qty, coil_count);
    }

    const totalQty = round3(coil_qtys.reduce((s, q) => s + Number(q), 0));
    const heat_no = String(
      req.body?.heat_no ?? draft?.heat_no ?? mrn.heat_no ?? mrn.it_lot_no ?? ""
    ).trim() || null;

    const user = auditUserName(req);

    const rejection = await insertQcRejection({
      mrn_refs: mrn.mrn_no != null ? String(mrn.mrn_no) : null,
      mrn_uids: uid,
      heat_nos: heat_no,
      item_codes: mrn.item_code || null,
      item_descs: mrn.item_desc || null,
      qtys: coil_qtys.join(","),
      total_qty: totalQty,
      coil_count,
      reason: MRN_PORTAL_REJECTION_REASON,
      remarks: `${remarks}${coil_count ? ` · ${coil_count} coil(s)` : ""}`,
      created_by: user,
    });

    const approvalFields = {};
    applyApprovalWorkflow({
      req,
      fields: approvalFields,
      incomingApproved: true,
      hasBusinessChanges: false,
      auditAsName: true,
    });
    await updateQcRejection(rejection.qc_reject_uid, approvalFields);
    const rejectedAt = new Date().toISOString();
    const rejectedMrn = await setMrnStickerRejected(uid, {
      reject_uid: rejection.qc_reject_uid,
      user,
      at: rejectedAt,
    });

    await log(req, "reject", uid, {
      uid,
      qc_reject_uid: rejection.qc_reject_uid,
      coil_count,
      coil_qtys,
      heat_no,
      remarks,
    }, rejection);

    return res.status(201).json({
      success: true,
      data: {
        uid,
        status: "reject",
        qc_reject_uid: rejection.qc_reject_uid,
        sticker_rejected_by: rejectedMrn?.sticker_rejected_by ?? user,
        sticker_rejected_at: rejectedMrn?.sticker_rejected_at ?? rejectedAt,
      },
      message: "MRN rejected and sent to RM Rejection register.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Undo MRN Portal rejection — permanently delete register + local MRN when unused. */
export const cancelMrnPortalRejection = async (req, res) => {
  try {
    const canCancel = isSuperAdminUser(req.user) || Boolean(req?.permission?.can_authorize) || String(req?.user?.type || req?.user?.role || "").toLowerCase() === "super_admin";
    if (!canCancel) {
      return res.status(403).json({ success: false, message: "You do not have permission to cancel this rejection." });
    }

    const uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!uid) return res.status(400).json({ success: false, message: "MRN UID is required." });

    const mrn = await findMrnByUid(uid);
    if (!mrn || !mrn.sticker_rejected) {
      return res.status(400).json({ success: false, message: "This MRN is not in rejected status." });
    }
    if (mrn.sticker_generated || (await countCoilsForMrn(uid)) > 0) {
      return res.status(400).json({
        success: false,
        message: "Cancel is only allowed for rejections before sticker generation.",
      });
    }

    const rejectId = Number(mrn.sticker_reject_uid);
    if (!Number.isFinite(rejectId) || rejectId <= 0) {
      return res.status(400).json({ success: false, message: "Linked rejection register not found." });
    }

    const rejection = await findQcRejection(rejectId);
    if (!rejection || rejection.is_deleted) {
      if (!mrn.sticker_generated && (await countCoilsForMrn(uid)) === 0) {
        await hardDeleteMrnByUid(uid);
      }
      return res.json({
        success: true,
        message: "Local rejection data removed. MRN is back in ERP Pending.",
        data: { uid, status: "pending" },
      });
    }

    if (!isMrnPortalRejectionRow(rejection)) {
      return res.status(400).json({
        success: false,
        message: "Only MRN Portal rejections can be cancelled from here.",
      });
    }

    if (String(rejection.bill_no || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel — a bill number has already been attached.",
      });
    }

    if (await hasApprovedRejectionStoreOut(rejectId)) {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel — Store Out has already been authorized.",
      });
    }

    const outId = Number(rejection.out_uid);
    if (Number.isFinite(outId) && outId > 0) {
      const outEntry = await findOutEntry(outId);
      if (outEntry && !outEntry.is_deleted) {
        return res.status(400).json({
          success: false,
          message: `Cannot cancel — Store Out #${outId} has started. Delete Store Out first.`,
        });
      }
    }

    const user = auditUserName(req);
    const removed = await permanentlyRemoveUnusedMrnPortalRejection(rejection, { mrn_uid: uid });
    if (!removed.ok) {
      return res.status(400).json({ success: false, message: removed.message });
    }

    await log(req, "cancel_rejection", uid, {
      uid,
      qc_reject_uid: rejectId,
      permanent: true,
      mrn_deleted: removed.mrn_deleted,
    }, rejection);

    return res.json({
      success: true,
      message: "Rejection permanently deleted. MRN is back in ERP Pending.",
      data: {
        uid,
        status: "pending",
        qc_reject_uid: rejectId,
        mrn_deleted: removed.mrn_deleted,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** TC / RMTC upload — full replace on generate; partial allowed when one file changes. */
export const uploadMrnDocs = async (req, res) => {
  try {
    const uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!uid) return res.status(400).json({ success: false, message: "MRN UID is required." });

    const requireBoth = req.body?.require_both !== "false" && req.body?.require_both !== false;
    const merged = await mergeMrnDocUploads(req, uid, { requireBoth });
    if (merged.error) {
      return res.status(merged.error.status).json({ success: false, message: merged.error.message });
    }

    const finalMrn = await findMrnByUid(uid);
    if (!mrnHasBothDocs(finalMrn)) {
      return res.status(400).json({
        success: false,
        message: "Both the TC and RMTC documents are required.",
      });
    }

    const docs = {
      uid,
      tc_file_path: finalMrn.tc_file_path,
      tc_file_name: finalMrn.tc_file_name,
      rmtc_file_path: finalMrn.rmtc_file_path,
      rmtc_file_name: finalMrn.rmtc_file_name,
    };

    await log(req, "upload_docs", uid, {
      uid,
      tc_file_name: docs.tc_file_name,
      rmtc_file_name: docs.rmtc_file_name,
      uploaded_tc: !!req.files?.tc?.[0],
      uploaded_rmtc: !!req.files?.rmtc?.[0],
    }, docs);

    return res.json({
      success: true,
      data: docs,
      message: "Documents uploaded successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
