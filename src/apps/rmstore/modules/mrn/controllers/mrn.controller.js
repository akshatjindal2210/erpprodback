import { findAllActiveMrnByUid, findGeneratedMrns, findMrnByUid, insertMrn, resetMrnStickerGenerated } from "../models/mrn.model.js";
import { countStoreInCoilsForMrn, softDeleteCoilsByMrn, findCoils } from "../../coil/models/coil.model.js";
import { softDeleteQcChecksByMrn } from "../../qc-check/models/qcCheck.model.js";
import { fetchFromIMS } from "../../../../ims/lib/services/ims.service.js";
import { logRmstoreActivity } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { getMrnCoilQtyEditable, getMrnCoilQtyAutoCalc, getMrnStickerMode } from "../../../../core/configuration/models/appConfig.model.js";

const MODULE = "rm_mrn_portal";

const log = (req, action, entity_id, details, record = null) =>
  logRmstoreActivity(req, { action, entity: MODULE, entity_id, details, record }).catch(() => {});

/** Map ERP `mrn_rm` row → normalized shape. */
export function mapErpMrnRecord(r = {}) {
  return {
    uid: r.uid != null ? String(r.uid) : null,
    mrn_no: r.mrnno ?? r.mrn_no ?? null,
    serial_no: r.itsrno ?? r.serial_no ?? null,
    mrn_dt: r.mrndt ?? r.mrn_dt ?? null,
    bill_no: r.billno ?? r.bill_no ?? null,
    bill_dt: r.billdt ?? r.bill_dt ?? null,
    acc_code: r.acc_code ?? null,
    acc_name: r.acc_name ?? null,
    item_dcode: r.itemdcode ?? r.item_dcode ?? null,
    item_code: r.itemcode ?? r.item_code ?? null,
    item_desc: r.itemdesc ?? r.item_desc ?? null,
    it_recp_qty: r.itrecpqty ?? r.it_recp_qty ?? null,
    it_lot_no: r.itLotNo ?? r.itlotno ?? r.it_lot_no ?? null,
    it_unit: r.itunit ?? r.it_unit ?? null,
    fyid: r.fyid ?? null,
    totalqty: r.totalqty ?? null,
    userc: r.userc ?? r.Userc ?? null,
    datec: r.datec ?? r.Datec ?? null,
    internal_create_user: r.internal_create_user ?? r.userc ?? r.Userc ?? null,
    internal_create_date: r.internal_create_date ?? r.datec ?? r.Datec ?? null,
    it_remarks: r.itRemarks ?? r.it_remarks ?? null,
  };
}

function matchesSearch(row, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return true;
  const sources = [row, row?.ims_source, row?.local_source].filter(Boolean);
  return sources.some((src) =>
    [
      src.uid, src.mrn_no, src.bill_no, src.item_code, src.item_desc,
      src.acc_name, src.it_lot_no, src.serial_no,
    ].some((v) => String(v ?? "").toLowerCase().includes(q))
  );
}

function slicePage(rows, page = 1, limit = 1000) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const start = (safePage - 1) * safeLimit;
  return {
    data: rows.slice(start, start + safeLimit),
    total: rows.length,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(rows.length / safeLimit) || 1,
  };
}

function inDateRange(row, from_date, to_date) {
  if (!from_date && !to_date) return true;
  if (!row?.mrn_dt) return false;
  const t = new Date(row.mrn_dt).getTime();
  if (!Number.isFinite(t)) return false;
  if (from_date) {
    const from = new Date(from_date).getTime();
    if (Number.isFinite(from) && t < from) return false;
  }
  if (to_date) {
    const to = new Date(to_date).getTime();
    if (Number.isFinite(to) && t > to) return false;
  }
  return true;
}

function toCalendarDateKey(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if (!s || /invalid/i.test(s)) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normCompareText(v) {
  if (v == null) return "";
  return String(v).trim().toUpperCase();
}

const QTY_COMPARE_EPS = 0.001;

function normCompareQty(v) {
  const n = parseFloat(String(v ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function compareTextField(imsVal, localVal) {
  const ims = normCompareText(imsVal);
  const local = normCompareText(localVal);
  return { ims: ims || imsVal || "", local: local || localVal || "", mismatch: ims !== local };
}

function compareQtyField(imsVal, localVal) {
  const ims = normCompareQty(imsVal);
  const local = normCompareQty(localVal);
  return { ims, local, mismatch: Math.abs(ims - local) > QTY_COMPARE_EPS };
}

function compareDateField(imsVal, localVal) {
  const imsKey = toCalendarDateKey(imsVal);
  const localKey = toCalendarDateKey(localVal);
  return {
    ims: imsKey || imsVal || "",
    local: localKey || localVal || "",
    mismatch: imsKey !== localKey && Boolean(imsKey || localKey),
  };
}

function isDbStickerGenerated(dbRow) {
  return dbRow?.sticker_generated === true || dbRow?.sticker_generated === "true";
}

function hasStickerDraft(dbRow) {
  const raw = dbRow?.sticker_draft;
  if (!raw) return false;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed != null && typeof parsed === "object" && Object.keys(parsed).length > 0;
    } catch {
      return false;
    }
  }
  return typeof raw === "object" && Object.keys(raw).length > 0;
}

function decoratePendingListRow(erpRow, dbRow) {
  const draft = hasStickerDraft(dbRow);
  return {
    ...erpRow,
    status: draft ? "draft" : "pending",
    id: erpRow.uid,
    sticker_generated: false,
    has_sticker_draft: draft,
    sticker_draft_at: dbRow?.sticker_draft_at ?? null,
    sticker_draft_by: dbRow?.sticker_draft_by ?? null,
  };
}

/** Frozen MRN columns saved in RM Store at sticker generate (DB side of comparison). */
function buildMrnLocalSnapshot(dbRow) {
  if (!dbRow) return null;
  return {
    uid: dbRow.uid != null ? String(dbRow.uid) : null,
    mrn_no: dbRow.mrn_no ?? null,
    serial_no: dbRow.serial_no ?? null,
    mrn_dt: dbRow.mrn_dt ?? null,
    bill_no: dbRow.bill_no ?? null,
    bill_dt: dbRow.bill_dt ?? null,
    acc_code: dbRow.acc_code ?? null,
    acc_name: dbRow.acc_name ?? null,
    item_dcode: dbRow.item_dcode ?? null,
    item_code: dbRow.item_code ?? null,
    item_desc: dbRow.item_desc ?? null,
    it_recp_qty: dbRow.it_recp_qty ?? null,
    it_lot_no: dbRow.it_lot_no ?? null,
    it_unit: dbRow.it_unit ?? null,
  };
}

/**
 * Compare live ERP (`mrn_rm`) with the MRN snapshot stored in RM Store.
 * Mirrors the IMS daily-production comparison pattern (`ims_source` vs `local_source`).
 */
function buildMrnComparison(imsRow, localRow) {
  if (!imsRow || !localRow) return { has_mismatch: false, fields: {} };
  const fields = {
    mrn_dt: compareDateField(imsRow.mrn_dt, localRow.mrn_dt),
    bill_no: compareTextField(imsRow.bill_no, localRow.bill_no),
    bill_dt: compareDateField(imsRow.bill_dt, localRow.bill_dt),
    item_code: compareTextField(imsRow.item_code, localRow.item_code),
    it_recp_qty: compareQtyField(imsRow.it_recp_qty, localRow.it_recp_qty),
    it_lot_no: compareTextField(imsRow.it_lot_no, localRow.it_lot_no),
    acc_code: compareTextField(imsRow.acc_code, localRow.acc_code),
  };
  return {
    has_mismatch: Object.entries(fields).some(([k, f]) => k !== "acc_code" && f.mismatch),
    fields,
  };
}

function decorateGeneratedListRow(dbRow, { qty_editable, qty_auto_calc, imsRow = null } = {}) {
  return {
    ...dbRow,
    uid: dbRow.uid,
    id: dbRow.uid,
    status: "generated",
    sticker_generated: true,
    userc: dbRow.internal_create_user ?? imsRow?.userc ?? null,
    datec: dbRow.internal_create_date ?? imsRow?.datec ?? null,
    created_by_name: dbRow.system_generate_user_name ?? dbRow.created_by_name ?? null,
    created_at: dbRow.system_generate_date ?? dbRow.created_at ?? null,
    qty_editable,
    qty_auto_calc,
    sticker_mode: dbRow.sticker_mode || "coil",
  };
}

/**
 * Pending = ERP row with no stickers (not in DB, or sticker_generated = false).
 * Generated = sticker_generated = true.
 * Comparison = live ERP vs saved RM Store MRN (mismatches only).
 */
export const getMrnList = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body, {
      sortBy: "mrn_dt",
      order: "DESC",
    });
    const status = String(filters?.status || "pending").toLowerCase();
    const q = sanitizeSearch(search);
    const from_date = filters?.from_date || null;
    const to_date = filters?.to_date || null;

    if (status === "generated") {
      const result = await findGeneratedMrns({ search: q, page, limit, from_date, to_date });
      const [qty_editable, qty_auto_calc, sticker_mode] = await Promise.all([
        getMrnCoilQtyEditable(),
        getMrnCoilQtyAutoCalc(),
        getMrnStickerMode(),
      ]);
      const data = (result.data || []).map((row) => ({
        ...row,
        status: "generated",
        id: row.uid,
        sticker_generated: !!row.sticker_generated,
        userc: row.internal_create_user ?? row.userc ?? null,
        datec: row.internal_create_date ?? row.datec ?? null,
        created_by_name: row.system_generate_user_name ?? row.created_by_name ?? null,
        created_at: row.system_generate_date ?? row.created_at ?? null,
        qty_editable,
        qty_auto_calc,
        // Legacy generated rows with null mode were coil-wise (before master sticker_mode).
        sticker_mode: row.sticker_mode || "coil",
      }));
      return res.json({ success: true, ...result, data, qty_editable, qty_auto_calc, sticker_mode });
    }

    if (status === "comparison") {
      const [erpRecords, dbMap, qty_editable, qty_auto_calc, sticker_mode] = await Promise.all([
        fetchFromIMS("mrn_rm"),
        findAllActiveMrnByUid(),
        getMrnCoilQtyEditable(),
        getMrnCoilQtyAutoCalc(),
        getMrnStickerMode(),
      ]);

      const imsByUid = new Map();
      for (const raw of erpRecords || []) {
        const mapped = mapErpMrnRecord(raw);
        if (mapped.uid) imsByUid.set(String(mapped.uid), mapped);
      }

      let rows = [];
      const matchedUids = new Set();
      const cfg = { qty_editable, qty_auto_calc };

      // Start from live ERP rows that already have stickers in RM Store.
      for (const [uid, imsRow] of imsByUid) {
        const dbRow = dbMap.get(uid);
        if (!isDbStickerGenerated(dbRow)) continue;

        if (!inDateRange(imsRow, from_date, to_date) && !inDateRange(dbRow, from_date, to_date)) {
          continue;
        }

        const local_source = buildMrnLocalSnapshot(dbRow);
        const comparison = buildMrnComparison(imsRow, local_source);
        if (!comparison.has_mismatch) continue;

        matchedUids.add(uid);
        // Keep the saved MRN as the list row. Live ERP values live only on ims_source.
        rows.push({
          ...decorateGeneratedListRow(dbRow, { ...cfg, imsRow }),
          ims_source: imsRow,
          local_source,
          comparison,
          has_comparison_mismatch: true,
        });
      }

      // Stickers exist in RM Store but the uid is missing from live ERP.
      for (const [uid, dbRow] of dbMap) {
        if (!isDbStickerGenerated(dbRow) || matchedUids.has(uid) || imsByUid.has(uid)) continue;
        if (!inDateRange(dbRow, from_date, to_date)) continue;

        const local_source = buildMrnLocalSnapshot(dbRow);
        rows.push({
          ...decorateGeneratedListRow(dbRow, cfg),
          ims_source: null,
          local_source,
          comparison: { has_mismatch: true, fields: {}, missing_ims: true },
          has_comparison_mismatch: true,
          ims_missing: true,
        });
      }

      if (q) rows = rows.filter((r) => matchesSearch(r, q));

      rows.sort((a, b) => {
        const da = a.mrn_dt ? new Date(a.mrn_dt).getTime() : 0;
        const db = b.mrn_dt ? new Date(b.mrn_dt).getTime() : 0;
        if (db !== da) return db - da;
        return Number(b.mrn_no || 0) - Number(a.mrn_no || 0);
      });

      const out = slicePage(rows, page, limit || rows.length || 1000);
      return res.json({
        success: true,
        ...out,
        data: out.data,
        qty_editable,
        qty_auto_calc,
        sticker_mode,
      });
    }

    const [erpRecords, dbMap] = await Promise.all([
      fetchFromIMS("mrn_rm"),
      findAllActiveMrnByUid(),
    ]);

    let rows = (erpRecords || []).map(mapErpMrnRecord).filter((r) => r.uid);

    if (status === "pending") {
      rows = rows.filter((r) => {
        const saved = dbMap.get(r.uid);
        return !saved || !isDbStickerGenerated(saved);
      });
      rows = rows.map((r) => decoratePendingListRow(r, dbMap.get(r.uid)));
    } else {
      // all — merge ERP with DB status
      rows = rows.map((r) => {
        const saved = dbMap.get(r.uid);
        if (isDbStickerGenerated(saved)) {
          return {
            ...saved,
            ...r,
            uid: saved.uid,
            status: "generated",
            id: saved.uid,
            sticker_generated: true,
            created_by_name: saved.system_generate_user_name ?? saved.created_by_name,
            created_at: saved.system_generate_date ?? saved.created_at,
            userc: saved.internal_create_user ?? r.userc ?? null,
            datec: saved.internal_create_date ?? r.datec ?? null,
            internal_create_user: saved.internal_create_user ?? r.internal_create_user ?? null,
            internal_create_date: saved.internal_create_date ?? r.internal_create_date ?? null,
          };
        }
        return decoratePendingListRow(r, saved);
      });
    }

    if (q) rows = rows.filter((r) => matchesSearch(r, q));
    if (from_date || to_date) rows = rows.filter((r) => inDateRange(r, from_date, to_date));

    rows.sort((a, b) => {
      const da = a.mrn_dt ? new Date(a.mrn_dt).getTime() : 0;
      const db = b.mrn_dt ? new Date(b.mrn_dt).getTime() : 0;
      if (db !== da) return db - da;
      return Number(b.mrn_no || 0) - Number(a.mrn_no || 0);
    });

    const out = slicePage(rows, page, limit || rows.length || 1000);
    const [qty_editable, qty_auto_calc, sticker_mode] = await Promise.all([
      getMrnCoilQtyEditable(),
      getMrnCoilQtyAutoCalc(),
      getMrnStickerMode(),
    ]);
    return res.json({
      success: true,
      ...out,
      data: (out.data || []).map((r) => ({
        ...r,
        qty_editable,
        qty_auto_calc,
        sticker_mode: r.sticker_mode || (r.sticker_generated ? "coil" : sticker_mode),
      })),
      qty_editable,
      qty_auto_calc,
      sticker_mode,
    });
  } catch (err) {
    console.error("[rmstore/mrn/list]", err?.message || err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const generateMrn = async (req, res) => {
  try {
    const body = req.body || {};
    const uid = body.uid != null ? String(body.uid).trim() : "";
    if (!uid) {
      return res.status(400).json({ success: false, message: "MRN UID is required." });
    }

    const existing = await findMrnByUid(uid);
    if (existing) {
      if (existing.sticker_generated) {
        return res.status(409).json({
          success: false,
          message: "This MRN has already been generated.",
          data: { ...existing, status: "generated", sticker_generated: true },
        });
      }
      return res.json({
        success: true,
        data: { ...existing, status: "pending", id: existing.uid, sticker_generated: false },
        message: "This MRN has already been saved.",
      });
    }

    // Prefer payload fields; fall back to ERP lookup by uid
    let source = mapErpMrnRecord(body);
    if (!source.mrn_no && !source.item_dcode) {
      const erpRecords = await fetchFromIMS("mrn_rm");
      const hit = (erpRecords || []).map(mapErpMrnRecord).find((r) => r.uid === uid);
      if (!hit) {
        return res.status(404).json({ success: false, message: "MRN not found in ERP." });
      }
      source = hit;
    }
    source.uid = uid;

    const row = await insertMrn({
      ...source,
      system_generate_user: null,
      sticker_generated: false,
    });

    await log(req, "create", row.uid, { uid, mrn_no: row.mrn_no }, row);

    return res.status(201).json({
      success: true,
      data: { ...row, status: "pending", id: row.uid, sticker_generated: false },
      message: "MRN saved successfully.",
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: "This MRN already exists." });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteGeneratedMrn = async (req, res) => {
  try {
    const uid = String(req.body?.uid ?? req.body?.mrn_uid ?? req.body?.id ?? "").trim();
    if (!uid) return res.status(400).json({ success: false, message: "MRN UID is required." });

    const existing = await findMrnByUid(uid);
    if (!existing) return res.status(404).json({ success: false, message: "MRN not found." });

    const storeInCount = await countStoreInCoilsForMrn(uid);
    if (storeInCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel these stickers because ${storeInCount} coil(s) have already been stored in. Reverse the Store In first.`,
      });
    }

    const deletedBy = auditUserName(req);
    // Read the coils before the soft-delete so the transaction log can name them.
    const removedCoils = await findCoils({ filters: { mrn_uid: uid }, limit: 5000 });
    await softDeleteQcChecksByMrn(uid, deletedBy);
    const deletedCoilCount = await softDeleteCoilsByMrn(uid, deletedBy);
    // Keep MRN row (no is_deleted) — only clear sticker flag so packing can regenerate (IMS-style).
    // Soft-deleted coils still FK to uid, so hard-deleting MRN would fail.
    await resetMrnStickerGenerated(uid);

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.STICKER_DELETE,
      source_module: "mrn_portal",
      source_id: uid,
      mrn_no: existing.mrn_no,
      user_name: deletedBy,
      user_id: req.user?.id,
      rows: removedCoils.data || [],
      details: {
        mrn_uid: uid,
        heat_no: removedCoils.data?.[0]?.heat_no ?? null,
        item_code: existing.item_code ?? null,
        coil_count: deletedCoilCount,
      },
    });

    await log(req, "delete", uid, { uid, deleted_coil_count: deletedCoilCount }, existing);

    return res.json({
      success: true,
      message: `Removed ${deletedCoilCount} coil sticker(s). You can generate them again when ready.`,
      deleted_coil_count: deletedCoilCount,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
