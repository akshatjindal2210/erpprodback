import { findMrnByUid, insertMrn, setMrnStickerGenerated, updateMrnDocs } from "../models/mrn.model.js";
import { formatCoilNoUid, countCoilsForMrn, insertBulkCoils, findCoils, softDeleteCoilsByCoilNoUids } from "../../coil/models/coil.model.js";
import { softDeleteQcChecksByCoilNoUids } from "../../qc-check/models/qcCheck.model.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { getBoxNoUidPrefix, getMrnCoilQtyEditable, getMrnCoilQtyAutoCalc, getMrnStickerMode, getMrnStickerRequireSpec } from "../../../../core/configuration/models/appConfig.model.js";
import { findSpecsByItem } from "../../spec/models/specMaster.model.js";
import { logRmstoreActivity } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { toRmPublicUploadPath } from "../../../lib/middleware/upload.js";

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

/**
 * Uneven integer split — total balanced; middle coils tend higher than ends.
 * Used when App Config "Auto-split coil quantities" is Enabled.
 */
export function splitQtyAcrossCoils(totalQty, coilCount) {
  const n = Math.max(1, Number(coilCount) || 1);
  const total = round3(totalQty);
  if (n === 1) return [total];

  const base = Math.floor(total / n);
  const maxDelta = Math.max(1, Math.floor(base * 0.12));
  const qtys = [];
  let allocated = 0;
  for (let i = 0; i < n - 1; i++) {
    const t = n === 2 ? 0 : i / (n - 2);
    const wave = Math.round(Math.sin(t * Math.PI) * maxDelta);
    const q = Math.max(0, base + wave);
    qtys.push(q);
    allocated += q;
  }
  qtys.push(Math.max(0, total - allocated));
  return qtys;
}

/**
 * Equal integer split — as even as possible; remainder (+1) on first coils.
 * Used when Auto-split is Disabled and qty fields are locked.
 */
export function equalSplitQtyAcrossCoils(totalQty, coilCount) {
  const n = Math.max(1, Number(coilCount) || 1);
  const total = round3(totalQty);
  if (n === 1) return [total];
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
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
    const mrn = await findMrnByUid(uid);
    if (!mrn) return res.status(404).json({ success: false, message: "MRN not found." });
    const coils = await findCoils({ filters: { mrn_uid: uid }, limit: 5000, sortBy: "coil_index", order: "ASC" });
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

    if (mrn.sticker_generated || (await countCoilsForMrn(uid)) > 0) {
      return res.status(409).json({
        success: false,
        message: "Stickers have already been generated for this MRN.",
      });
    }

    if (await getMrnStickerRequireSpec()) {
      const itemDcode = Number(mrn.item_dcode);
      if (!Number.isFinite(itemDcode) || itemDcode <= 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot generate stickers because the RM item is missing on this MRN. Add it in RM Spec Master, or turn off Require RM Spec in App Config.",
        });
      }
      const specs = await findSpecsByItem(itemDcode);
      if (!specs.length) {
        return res.status(400).json({
          success: false,
          message: `Cannot generate stickers because no RM Spec Master exists for item ${mrn.item_code || itemDcode}. Create the specifications first, or turn off Require RM Spec in App Config.`,
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
        coil_index: i,
        total_coils: coil_count,
        remarks,
        created_by: user,
      });
    }

    let created = [];
    try {
      created = await insertBulkCoils(rows);
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

export const getMrnCoils = async (req, res) => {
  try {
    const uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!uid) return res.status(400).json({ success: false, message: "MRN UID is required." });
    const heat_no = req.body?.heat_no != null ? String(req.body.heat_no).trim() : "";
    const result = await findCoils({
      filters: { mrn_uid: uid, ...(heat_no ? { heat_no } : {}) },
      limit: 5000,
      sortBy: "coil_uid",
      order: "ASC",
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Separate TC / RMTC upload after stickers exist — both required. */
export const uploadMrnDocs = async (req, res) => {
  try {
    const uid = String(req.body?.uid ?? req.body?.mrn_uid ?? "").trim();
    if (!uid) return res.status(400).json({ success: false, message: "MRN UID is required." });

    const mrn = await findMrnByUid(uid);
    if (!mrn) return res.status(404).json({ success: false, message: "MRN not found." });

    const tcFile = req.files?.tc?.[0] || null;
    const rmtcFile = req.files?.rmtc?.[0] || null;
    if (!tcFile || !rmtcFile) {
      return res.status(400).json({
        success: false,
        message: "Both the TC and RMTC documents are required.",
      });
    }

    const docs = {
      tc_file_path: toRmPublicUploadPath(tcFile, "tc"),
      tc_file_name: tcFile.originalname,
      rmtc_file_path: toRmPublicUploadPath(rmtcFile, "rmtc"),
      rmtc_file_name: rmtcFile.originalname,
    };
    await updateMrnDocs(uid, docs);

    await log(req, "upload_docs", uid, {
      uid,
      tc_file_name: docs.tc_file_name,
      rmtc_file_name: docs.rmtc_file_name,
    }, { uid, ...docs });

    return res.json({
      success: true,
      data: { uid, ...docs },
      message: "Documents uploaded successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
