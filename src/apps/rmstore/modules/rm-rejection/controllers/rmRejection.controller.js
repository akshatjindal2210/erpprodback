import { findQcRejections, findQcRejection, findIncompleteRejectionRegisters, insertQcRejection, updateQcRejection, softDeleteQcRejection, attachRejectionCoils, hasApprovedRejectionStoreOut, isMrnPortalRejectionRow, permanentlyRemoveUnusedMrnPortalRejection, primaryMrnUidFromRejection } from "../models/rmRejection.model.js";
import { findInProcessRequest, findInProcessRejectionsPendingRejection, normalizeRequestType, IPR_DOWNSTREAM, IPR_REQUEST_TYPE } from "../../in-process-request/models/inProcessRequest.model.js";
import { findCoilByUid, findCoilUidsByQcCheck, linkCoilsToRejectionRegister, revertCoilsFromRejectionRegister, findCoils, updateCoilsAfterQcReject } from "../../coil/models/coil.model.js";
import { findQcCheck, findFailedQcChecksPendingRejection, reopenQcChecksForRejection, linkFailedQcChecksToRejection } from "../../qc-check/models/qcCheck.model.js";
import { findOutEntry, findOutEntries, buildOutEntryCoilSummary } from "../../out-entry/models/outEntry.model.js";
import { findMrnByUid } from "../../mrn/models/mrn.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalUpdateFields, applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { fetchFromIMS } from "../../../../ims/lib/services/ims.service.js";
import { assertWithinEditDays } from "../../../../../platform/utils/auth/permissionDays.js";

const MODULE = "rm_rejection";
const log = createRmstoreActivityLogger(MODULE);

async function resolveCoilsForQcCheck(check) {
  const qcCheckUid = Number(check?.qc_check_uid);
  let coilUidList = Number.isFinite(qcCheckUid) ? await findCoilUidsByQcCheck(qcCheckUid) : [];
  if (!coilUidList.length) {
    coilUidList = String(check?.coil_no_uid || "")
      .split(/[,|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const resolved = [];
  for (const uid of coilUidList) {
    const coil = await findCoilByUid(uid);
    if (coil) resolved.push(coil);
  }
  return { coilUidList, resolved };
}

async function findActiveStoreOutForRejection(rejection) {
  const id = Number(rejection?.qc_reject_uid);
  if (!Number.isFinite(id)) return null;
  const outId = Number(rejection?.out_uid);
  if (Number.isFinite(outId) && outId > 0) {
    const row = await findOutEntry(outId);
    if (row) return row;
  }
  const linked = await findOutEntries({ filters: { rm_uid: id }, limit: 1 });
  return linked.data?.[0] ?? null;
}

/** Save remarks + authorize register for Store Out Pending (no out_entry, no coil pre-fill). */
async function finalizeRejectionRegisterForStoreOutQueue({ rejectionId, user, remarks, req }) {
  const rejectId = Number(rejectionId);
  let rejection = await findQcRejection(rejectId);
  if (!rejection) {
    const err = new Error("QC rejection record not found.");
    err.status = 404;
    throw err;
  }

  const existingOut = await findActiveStoreOutForRejection(rejection);
  if (existingOut?.approved === true) {
    return { rejection, outEntry: existingOut, out_uid: existingOut.out_uid };
  }
  if (existingOut && existingOut.approved !== true) {
    const err = new Error(`Store Out #${existingOut.out_uid} is already in progress for this rejection.`);
    err.status = 400;
    throw err;
  }

  const rejectionFields = {};
  let hasBusinessChanges = false;

  if (rejection.out_uid != null) {
    rejectionFields.out_uid = null;
    hasBusinessChanges = true;
  }
  if (remarks !== undefined) {
    const nextRemarks = remarks != null ? String(remarks).trim() || null : null;
    const prevRemarks =
      rejection.remarks === null || rejection.remarks === undefined
        ? null
        : String(rejection.remarks).trim() || null;
    if (prevRemarks !== nextRemarks) {
      rejectionFields.remarks = nextRemarks;
      hasBusinessChanges = true;
    }
  }

  if (rejection.approved !== true && req) {
    applyApprovalUpdateFields({
      req,
      fields: rejectionFields,
      incomingApproved: true,
      hasBusinessChanges,
      alreadyApproved: false,
      auditAsName: true,
    });
  } else if (hasBusinessChanges) {
    rejectionFields.updated_by = user;
    rejectionFields.updated_at = new Date();
  }

  if (!Object.keys(rejectionFields).length) {
    return { rejection, outEntry: null, out_uid: rejection.out_uid ?? null };
  }

  await updateQcRejection(rejectId, rejectionFields);
  rejection = await findQcRejection(rejectId);

  return { rejection, outEntry: null, out_uid: null };
}

const PENDING_TYPE_FILTERS = new Set([
  "all",
  "qc_check",
  "in_process",
  "awaiting_store_out",
  "awaiting_bill",
]);

function normalizePendingTypeFilter(value) {
  const raw = String(value ?? "all").trim().toLowerCase();
  if (!raw || raw === "all") return "all";
  return PENDING_TYPE_FILTERS.has(raw) ? raw : "all";
}

function filterPendingRowsByType(rows, pendingType) {
  const type = normalizePendingTypeFilter(pendingType);
  if (type === "all") return rows;
  return (rows || []).filter((row) => {
    const src = String(row?.pending_source || row?.pending_type || "").trim().toLowerCase();
    if (type === "qc_check") return src === "qc_check";
    if (type === "in_process") return src === "in_process";
    if (type === "awaiting_store_out") {
      return src === "awaiting_store_out" || src === "awaiting_authorization";
    }
    if (type === "awaiting_bill") return src === "awaiting_bill";
    return true;
  });
}

function normMatchKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function firstItemCodeFromRow(row) {
  const raw = row?.item_codes ?? row?.item_code ?? "";
  return (
    String(raw)
      .split(/[,|]+/)
      .map((s) => s.trim())
      .find(Boolean) || null
  );
}

/**
 * invfnote uid: `{acc_code}-{item_dcode}-{packing}-{qty}` (e.g. 931-17834-41619-18000)
 * Same join as Gate Entry / Forwarding Note.
 */
function invfnoteUidParts(rec = {}) {
  const raw = String(rec?.uid ?? "").trim() || String(rec?.muid ?? "").trim();
  const parts = raw.split("-").filter(Boolean);
  return {
    acc_code: parts[0] ? String(parts[0]).trim() : null,
    item_dcode: parts[1] ? String(parts[1]).trim() : null,
  };
}

function invfnoteSaleCat(rec = {}) {
  return String(rec?.salecat ?? rec?.sale_cat ?? "").trim();
}

function invfnoteQty(rec = {}) {
  const n = Number(rec?.itqty ?? rec?.ITQTY ?? rec?.qty);
  return Number.isFinite(n) ? n : null;
}

function qtyEquals(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 0.001;
}

/**
 * Pending awaiting_bill — only invfnote salecat=2 + Green.
 * Auto-match (no save): acc_code + item_code/itemdcode + qty (== itqty).
 * muid = `{acc}-{itemdcode}-{packing}` (e.g. 2377-18996-0).
 */
async function enrichPendingMatchedInvfnoteBills(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const needs = list.filter(
    (r) =>
      String(r?.pending_source || "").toLowerCase() === "awaiting_bill" &&
      !String(r?.bill_no || "").trim()
  );
  if (!needs.length) return list;

  let records = [];
  try {
    const invfnote = await fetchFromIMS("invfnote");
    records = (Array.isArray(invfnote) ? invfnote : []).filter(
      (rec) =>
        invfnoteSaleCat(rec) === "2" &&
        String(rec?.status ?? "").trim().toLowerCase() === "green"
    );
  } catch {
    records = [];
  }

  const mrnUids = [
    ...new Set(
      needs
        .filter((r) => !String(r?.vendor_acc_code ?? r?.acc_code ?? "").trim())
        .map((r) => primaryMrnUidFromRejection(r))
        .filter(Boolean)
    ),
  ];
  const mrnByUid = new Map();
  await Promise.all(
    mrnUids.map(async (uid) => {
      try {
        const mrn = await findMrnByUid(uid);
        if (mrn) mrnByUid.set(String(uid), mrn);
      } catch {
        /* skip */
      }
    })
  );

  const emptyMatch = {
    matched_bill_no: null,
    matched_bill_dt: null,
    matched_bill_status: null,
    matched_bill_acc_name: null,
    matched_bill_acc_code: null,
    matched_bill_item_code: null,
    matched_bill_muid: null,
    matched_bill_itqty: null,
    bill_matched: false,
  };

  return list.map((row) => {
    if (String(row?.pending_source || "").toLowerCase() !== "awaiting_bill") return row;
    if (String(row?.bill_no || "").trim()) return row;

    const mrnUid = primaryMrnUidFromRejection(row);
    const mrn = (mrnUid && mrnByUid.get(String(mrnUid))) || null;

    // Prefer SQL join fields (rejection → MRN create-time vendor/item); lookup only if join missed
    const vendorAccCode = String(row?.vendor_acc_code ?? row?.acc_code ?? mrn?.acc_code ?? "").trim() || null;
    const vendorAccNameRaw = String(row?.vendor_acc_name ?? row?.acc_name ?? mrn?.acc_name ?? "").trim() || null;
    const itemDcode = String(row?.match_item_dcode ?? row?.item_dcode ?? mrn?.item_dcode ?? "").trim() || null;
    const itemCodeRaw = String(row?.match_item_code ?? mrn?.item_code ?? "").trim() || firstItemCodeFromRow(row);
    const itemCode = normMatchKey(itemCodeRaw);
    const rejectQty = Number(row?.total_qty ?? row?.qty);

    const base = {
      ...row,
      vendor_acc_code: vendorAccCode,
      vendor_acc_name: vendorAccNameRaw,
      match_item_code: itemCodeRaw || null,
      match_item_dcode: itemDcode,
      match_qty: Number.isFinite(rejectQty) ? rejectQty : null,
      ...emptyMatch,
    };

    if (!records.length || !vendorAccCode || (!itemDcode && !itemCode)) return base;
    if (!Number.isFinite(rejectQty)) return base;

    for (const rec of records) {
      const billNo = normalizeImsBillNo(rec);
      if (!billNo) continue;

      const uidParts = invfnoteUidParts(rec);
      const billAccCode = String(rec?.acc_code ?? uidParts.acc_code ?? "").trim() || null;
      const billItemDcode = String(rec?.itemdcode ?? rec?.item_dcode ?? uidParts.item_dcode ?? "").trim() || null;
      const billItemCode = normMatchKey(rec?.item_code ?? rec?.itemcode);
      const billQty = invfnoteQty(rec);

      // acc_code + item (code or dcode) + qty
      if (String(vendorAccCode) !== String(billAccCode)) continue;
      const itemOk =
        (itemDcode && billItemDcode && String(itemDcode) === String(billItemDcode)) ||
        (itemCode && billItemCode && itemCode === billItemCode);
      if (!itemOk) continue;
      if (!qtyEquals(rejectQty, billQty)) continue;

      const muid = String(rec?.muid ?? "").trim() || null;
      return {
        ...base,
        matched_bill_no: billNo,
        matched_bill_dt: normalizeImsBillDt(rec),
        matched_bill_status: String(rec?.status ?? "").trim() || null,
        matched_bill_acc_name: String(rec?.acc_name ?? "").trim() || null,
        matched_bill_acc_code: billAccCode,
        matched_bill_item_code: String(rec?.item_code ?? rec?.itemcode ?? "").trim() || null,
        matched_bill_muid: muid,
        matched_bill_itqty: billQty,
        bill_matched: true,
      };
    }

    return base;
  });
}

async function loadPendingRejectionQueue({ search, pendingType, page = 1, limit = 5000 } = {}) {
  const type = normalizePendingTypeFilter(pendingType);
  const includeQc = type === "all" || type === "qc_check";
  const includeIpr = type === "all" || type === "in_process";
  const includeRegister = type === "all" || type === "awaiting_store_out" || type === "awaiting_bill";

  const [qcResult, iprResult, registerResult] = await Promise.all([
    includeQc
      ? findFailedQcChecksPendingRejection({ search, page: 1, limit: 5000 })
      : Promise.resolve({ data: [] }),
    includeIpr
      ? findInProcessRejectionsPendingRejection({ search, page: 1, limit: 5000 })
      : Promise.resolve({ data: [] }),
    includeRegister
      ? findIncompleteRejectionRegisters({ search, page: 1, limit: 5000 })
      : Promise.resolve({ data: [] }),
  ]);
  let merged = filterPendingRowsByType(
    [
      ...(registerResult.data || []),
      ...(iprResult.data || []),
      ...(qcResult.data || []),
    ],
    type,
  ).sort((a, b) => {
    const ta = new Date(a.approved_at || a.inspected_at || a.created_at || 0).getTime();
    const tb = new Date(b.approved_at || b.inspected_at || b.created_at || 0).getTime();
    return tb - ta;
  });

  merged = await enrichPendingMatchedInvfnoteBills(merged);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  return {
    data: merged.slice(offset, offset + safeLimit),
    total: merged.length,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(merged.length / safeLimit) || 1,
  };
}

/** Unified pending queue — QC fail, in-process rejection, + incomplete register workflow rows. */
export const getPendingRejectionQueueList = async (req, res) => {
  try {
    const { page, limit, search, filters } = extractListParams(req.body || {}, {
      sortBy: "qc_check_uid",
      order: "DESC",
    });
    const safeFilters = sanitizeFilters(filters || {}, ["pending_type", "pendingType"]);
    const pendingType = safeFilters.pending_type ?? safeFilters.pendingType;
    const result = await loadPendingRejectionQueue({
      search: sanitizeSearch(search),
      pendingType,
      page,
      limit,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getQcRejections = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "qc_reject_uid",
      order: "DESC",
    });
    const safeFilters = sanitizeFilters(filters || {}, [
      "approved",
      "from_date",
      "to_date",
      "status",
      "register_complete",
      "pending_type",
      "pendingType",
    ]);
    const status = String(safeFilters.status || "").trim().toLowerCase();

    // Pending = failed QC + in-process rejection + store-out done awaiting bill
    if (status === "pending") {
      const pendingType = safeFilters.pending_type ?? safeFilters.pendingType;
      const result = await loadPendingRejectionQueue({
        search: sanitizeSearch(search),
        pendingType,
        page,
        limit,
      });
      return res.json({ success: true, ...result });
    }

    const listFilters = { ...safeFilters };
    delete listFilters.status;

    const result = await findQcRejections({
      filters: listFilters,
      search: sanitizeSearch(search),
      page,
      limit,
      permission: req.permission,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getQcRejectionById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_reject_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC rejection ID is required." });
    const data = await findQcRejection(id);
    if (!data) return res.status(404).json({ success: false, message: "QC rejection record not found." });
    const [enriched] = await attachRejectionCoils([data]);
    return res.json({ success: true, data: enriched });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Create QC rejection from scanned active coils.
 * body: { coils: [{ coil_no_uid }], reason, remarks, approved }
 */
export const createQcRejection = async (req, res) => {
  try {
    const coilInputs = Array.isArray(req.body?.coils) ? req.body.coils : [];
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : "";
    const remarks = req.body?.remarks != null ? String(req.body.remarks).trim() : null;
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);

    if (!reason) {
      return res.status(400).json({ success: false, message: "A rejection reason is required." });
    }
    if (!coilInputs.length) {
      return res.status(400).json({ success: false, message: "At least one coil is required." });
    }

    const uids = coilInputs.map((c) =>
      typeof c === "string" ? c.trim() : String(c?.coil_no_uid || "").trim()
    ).filter(Boolean);

    const resolved = [];
    for (const uid of uids) {
      const coil = await findCoilByUid(uid);
      if (!coil) {
        return res.status(400).json({ success: false, message: `Coil ${uid} was not found.` });
      }
      const status = String(coil.status || "active").toLowerCase();
      if (status !== "active") {
        return res.status(400).json({ success: false, message: `Coil ${uid} is not available. Its current status is ${status}.` });
      }
      resolved.push(coil);
    }

    const summary = buildOutEntryCoilSummary(resolved);
    const user = auditUserName(req);

    const row = await insertQcRejection({
      mrn_refs: summary.mrn_refs,
      mrn_uids: summary.mrn_uids,
      heat_nos: summary.heat_nos,
      item_codes: summary.item_codes,
      item_descs: summary.item_descs,
      qtys: summary.qtys,
      total_qty: summary.total_qty,
      coil_count: summary.coil_count,
      reason,
      remarks,
      created_by: user,
    });

    await updateCoilsAfterQcReject(row.qc_reject_uid, uids, user);
    await linkFailedQcChecksToRejection(row.qc_reject_uid, uids, user);

    if (normalizedApproved === true) {
      const fields = {};
      applyApprovalWorkflow({
        req, fields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      await updateQcRejection(row.qc_reject_uid, fields);
    }

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.QC_REJECT,
      source_module: "rm_rejection",
      source_id: String(row.qc_reject_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: resolved,
      details: { qc_reject_uid: row.qc_reject_uid, reason, coil_count: resolved.length },
    });

    const data = await findQcRejection(row.qc_reject_uid);
    const coils = await findCoils({ filters: { rm_uid: row.qc_reject_uid }, limit: 5000 });
    log(req, "create", String(row.qc_reject_uid), {
      qc_reject_uid: row.qc_reject_uid,
      reason,
      coil_count: resolved.length,
      coil_no_uids: resolved.map((c) => c.coil_no_uid),
      source: "manual",
    }, data);
    return res.status(201).json({
      success: true,
      data: { ...data, coils: coils.data },
      message: "QC rejection recorded successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Move a virtual Rejection Pending (failed QC check, no qc_reject_uid) into Rejection Register (DB).
 * body: { qc_check_uid, reason?, remarks?, approved? }
 */
export const registerQcRejectionFromCheck = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_check_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC check ID is required." });

    const check = await findQcCheck(id);
    if (!check) return res.status(404).json({ success: false, message: "QC check not found." });
    if (String(check.status || "").toLowerCase() !== "failed") {
      return res.status(400).json({
        success: false,
        message: `Only a failed QC check can be registered. This check is currently ${check.status}.`,
      });
    }
    if (check.qc_reject_uid) {
      return res.status(400).json({
        success: false,
        message: `This QC check is already linked to QC rejection #${check.qc_reject_uid}.`,
      });
    }

    const reason =
      (req.body?.reason != null ? String(req.body.reason).trim() : "") ||
      String(check.failure_reason || "").trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: "A rejection reason is required." });
    }
    const remarks =
      req.body?.remarks != null
        ? String(req.body.remarks).trim()
        : check.remarks || `From QC Check #${id}`;
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);
    const user = auditUserName(req);

    const { coilUidList, resolved } = await resolveCoilsForQcCheck(check);
    if (!resolved.length) {
      return res.status(400).json({ success: false, message: "No coils were found for this QC check." });
    }
    const summary = buildOutEntryCoilSummary(resolved);

    const row = await insertQcRejection({
      mrn_refs: summary.mrn_refs || (check.mrn_no != null ? String(check.mrn_no) : null),
      mrn_uids: summary.mrn_uids || check.mrn_uid || null,
      heat_nos: summary.heat_nos || check.heat_no || null,
      item_codes: summary.item_codes || check.item_code || null,
      item_descs: summary.item_descs || check.item_desc || null,
      qtys: summary.qtys,
      total_qty: summary.total_qty,
      coil_count: summary.coil_count,
      reason,
      remarks,
      created_by: user,
    });

    await updateCoilsAfterQcReject(row.qc_reject_uid, coilUidList, user);
    await linkFailedQcChecksToRejection(row.qc_reject_uid, coilUidList, user);

    if (normalizedApproved === true) {
      const fields = {};
      applyApprovalWorkflow({
        req, fields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      await updateQcRejection(row.qc_reject_uid, fields);
    }

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.QC_REJECT,
      source_module: "rm_rejection",
      source_id: String(row.qc_reject_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: resolved,
      details: { qc_reject_uid: row.qc_reject_uid, qc_check_uid: id, reason, from_qc_check: true },
    });

    const data = await findQcRejection(row.qc_reject_uid);
    const coils = await findCoils({ filters: { rm_uid: row.qc_reject_uid }, limit: 5000 });
    log(req, "create_from_qc_check", String(row.qc_reject_uid), {
      qc_reject_uid: row.qc_reject_uid,
      qc_check_uid: id,
      coil_count: resolved.length,
      reason,
    }, data);
    return res.status(201).json({
      success: true,
      data: { ...data, coils: coils.data },
      toast_type: "success",
      message: "Moved to the Rejection Register successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Pending failed QC → Rejection Register → Store Out Pending (scan/authorize there).
 * body: { qc_check_uid, reason?, remarks?, approved? }
 */
export const generateStoreOutFromQcCheck = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_check_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC check ID is required." });

    const check = await findQcCheck(id);
    if (!check) return res.status(404).json({ success: false, message: "QC check not found." });
    if (String(check.status || "").toLowerCase() !== "failed") {
      return res.status(400).json({
        success: false,
        message: `Only a failed QC check can generate a Store Out. This check is currently ${check.status}.`,
      });
    }
    if (check.qc_reject_uid) {
      return res.status(400).json({
        success: false,
        message: `This QC check is already linked to QC rejection #${check.qc_reject_uid}.`,
      });
    }

    const reason =
      (req.body?.reason != null ? String(req.body.reason).trim() : "") ||
      String(check.failure_reason || "").trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: "A rejection reason is required." });
    }
    const remarks =
      req.body?.remarks != null
        ? String(req.body.remarks).trim()
        : check.remarks || `RM Rejection from QC Check #${id}`;
    const user = auditUserName(req);

    const { coilUidList, resolved } = await resolveCoilsForQcCheck(check);
    if (!resolved.length) {
      return res.status(400).json({ success: false, message: "No coils were found for this QC check." });
    }
    for (const coil of resolved) {
      const uid = coil.coil_no_uid;
      const coilStatus = String(coil.status || "active").toLowerCase();
      const qcFailHeld =
        coilStatus === "rejected" &&
        !coil.rm_uid &&
        !coil.out_uid &&
        (String(coil.qc_check_status || "").toLowerCase() === "failed" ||
          Number(coil.qc_uid) === id);
      if (coilStatus !== "active" && !qcFailHeld) {
        return res.status(400).json({
          success: false,
          message: `Coil ${uid} is not available. Its current status is ${coilStatus}.`,
        });
      }
      if (coil.out_uid) {
        return res.status(400).json({
          success: false,
          message: `Coil ${uid} is already linked to Store Out #${coil.out_uid}.`,
        });
      }
    }
    const summary = buildOutEntryCoilSummary(resolved);

    const rejection = await insertQcRejection({
      mrn_refs: summary.mrn_refs || (check.mrn_no != null ? String(check.mrn_no) : null),
      mrn_uids: summary.mrn_uids || check.mrn_uid || null,
      heat_nos: summary.heat_nos || check.heat_no || null,
      item_codes: summary.item_codes || check.item_code || null,
      item_descs: summary.item_descs || check.item_desc || null,
      qtys: summary.qtys,
      total_qty: summary.total_qty,
      coil_count: summary.coil_count,
      reason,
      remarks,
      created_by: user,
    });

    await linkCoilsToRejectionRegister(rejection.qc_reject_uid, coilUidList, user);
    await linkFailedQcChecksToRejection(rejection.qc_reject_uid, coilUidList, user);

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.QC_REJECT,
      source_module: "rm_rejection",
      source_id: String(rejection.qc_reject_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: resolved,
      details: {
        qc_reject_uid: rejection.qc_reject_uid,
        qc_check_uid: id,
        reason,
        from_qc_check: true,
        register_only: true,
      },
    });

    const rejectionData = await findQcRejection(rejection.qc_reject_uid);
    const registerCoils = await findCoils({ filters: { rm_uid: rejection.qc_reject_uid }, limit: 5000 });

    const { outEntry, out_uid } = await finalizeRejectionRegisterForStoreOutQueue({
      rejectionId: rejection.qc_reject_uid,
      user,
      remarks,
      req,
    });

    log(req, "generate_store_out", String(rejection.qc_reject_uid), {
      qc_reject_uid: rejection.qc_reject_uid,
      qc_check_uid: id,
      coil_count: coilUidList.length,
      register_approved: true,
    }, rejectionData);

    return res.status(201).json({
      success: true,
      data: {
        rejection: await findQcRejection(rejection.qc_reject_uid),
        coils: registerCoils.data || [],
        out_entry: outEntry,
        out_uid,
      },
      message: "Queued in Store Out Pending. Scan coils there, then authorize.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Approved in-process rejection → Rejection Register → Store Out Pending (scan/authorize there).
 * body: { ipr_uid, reason?, remarks?, approved? }
 */
export const generateStoreOutFromInProcessRequest = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.ipr_uid ?? req.body?.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "A valid in-process request ID is required." });
    }

    const ipr = await findInProcessRequest(id);
    if (!ipr) return res.status(404).json({ success: false, message: "In-process request not found." });
    if (normalizeRequestType(ipr.request_type) !== IPR_REQUEST_TYPE.REJECTION) {
      return res.status(400).json({ success: false, message: "Only an in-process rejection can generate Store Out." });
    }
    if (ipr.approved !== true) {
      return res.status(400).json({ success: false, message: "Authorize the in-process rejection before generating Store Out." });
    }
    if (ipr.downstream !== IPR_DOWNSTREAM.PENDING_STORE_OUT) {
      return res.status(400).json({
        success: false,
        message: "This in-process rejection is not pending Store Out (it may already be processed).",
      });
    }

    const reason =
      (req.body?.reason != null ? String(req.body.reason).trim() : "") ||
      String(ipr.reason || "").trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: "A rejection reason is required." });
    }
    const remarks =
      req.body?.remarks != null
        ? String(req.body.remarks).trim()
        : ipr.remarks || `RM Rejection from In-Process Request #${id}`;
    const user = auditUserName(req);

    const coilUids = (ipr.coils || []).map((c) => String(c?.coil_no_uid || "").trim()).filter(Boolean);
    if (!coilUids.length) {
      return res.status(400).json({ success: false, message: "There are no coils on this in-process rejection." });
    }

    const resolved = [];
    for (const uid of coilUids) {
      const coil = await findCoilByUid(uid);
      if (!coil) {
        return res.status(400).json({ success: false, message: `Coil ${uid} was not found.` });
      }
      const status = String(coil.status || "active").toLowerCase();
      if (status === "rejected" && Number(coil.ipr_uid) === id && !coil.rm_uid) {
        resolved.push(coil);
        continue;
      }
      if (status !== "active") {
        return res.status(400).json({
          success: false,
          message: `Coil ${uid} is not available for rejection store-out. Its current status is ${status}.`,
        });
      }
      resolved.push(coil);
    }

    const summary = buildOutEntryCoilSummary(resolved);
    const rejection = await insertQcRejection({
      ipr_uid: id,
      mrn_refs: summary.mrn_refs,
      mrn_uids: summary.mrn_uids,
      heat_nos: summary.heat_nos,
      item_codes: summary.item_codes,
      item_descs: summary.item_descs,
      qtys: summary.qtys,
      total_qty: summary.total_qty,
      coil_count: summary.coil_count,
      reason,
      remarks,
      created_by: user,
    });

    await linkCoilsToRejectionRegister(rejection.qc_reject_uid, coilUids, user, { fromIprUid: id });

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.QC_REJECT,
      source_module: "in_process_request",
      source_id: String(id),
      user_name: user,
      user_id: req.user?.id,
      rows: resolved,
      details: {
        ipr_uid: id,
        qc_reject_uid: rejection.qc_reject_uid,
        reason,
        rejection_type: ipr.rejection_type || null,
        coil_count: resolved.length,
        from_in_process: true,
        register_only: true,
      },
    });

    const rejectionData = await findQcRejection(rejection.qc_reject_uid);
    const registerCoils = await findCoils({ filters: { rm_uid: rejection.qc_reject_uid }, limit: 5000 });

    const { outEntry, out_uid } = await finalizeRejectionRegisterForStoreOutQueue({
      rejectionId: rejection.qc_reject_uid,
      user,
      remarks,
      req,
    });

    log(req, "generate_store_out_ipr", String(rejection.qc_reject_uid), {
      qc_reject_uid: rejection.qc_reject_uid,
      ipr_uid: id,
      coil_count: coilUids.length,
      register_approved: true,
    }, rejectionData);

    return res.status(201).json({
      success: true,
      data: {
        rejection: await findQcRejection(rejection.qc_reject_uid),
        coils: registerCoils.data || [],
        ipr_uid: id,
        out_entry: outEntry,
        out_uid,
      },
      message: "Queued in Store Out Pending. Scan coils there, then authorize.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Authorize RM Rejection register — queues on Store Out Pending (no out_entry until scan).
 * body: { qc_reject_uid, remarks? }
 */
export const approveRejectionRegister = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_reject_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC rejection ID is required." });

    let existing = await findQcRejection(id);
    if (!existing) return res.status(404).json({ success: false, message: "QC rejection record not found." });

    const editBlocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (editBlocked) {
      return res.status(editBlocked.status).json({ success: false, message: editBlocked.message });
    }

    const user = auditUserName(req);
    const rejectionFields = {};
    let hasBusinessChanges = false;

    if (existing.out_uid) {
      const outEntry = await findOutEntry(existing.out_uid);
      const hasOpenDraft = outEntry && !outEntry.is_deleted && outEntry.approved !== true;
      if (outEntry?.approved === true) {
        return res.status(400).json({
          success: false,
          message: `Store Out #${existing.out_uid} is already authorized for this rejection.`,
        });
      }
      if (!hasOpenDraft) {
        rejectionFields.out_uid = null;
        hasBusinessChanges = true;
      }
    }

    if (req.body?.remarks !== undefined) {
      const remarks =
        req.body.remarks != null ? String(req.body.remarks).trim() || null : null;
      const prevRemarks =
        existing.remarks === null || existing.remarks === undefined
          ? null
          : String(existing.remarks).trim() || null;
      if (prevRemarks !== remarks) {
        rejectionFields.remarks = remarks;
        hasBusinessChanges = true;
      }
    }

    const approvalOnly = !hasBusinessChanges && existing.approved !== true;

    if (existing.approved !== true) {
      applyApprovalUpdateFields({
        req,
        fields: rejectionFields,
        incomingApproved: true,
        hasBusinessChanges,
        alreadyApproved: false,
        auditAsName: true,
      });
    } else if (hasBusinessChanges) {
      rejectionFields.updated_by = user;
      rejectionFields.updated_at = new Date();
    }

    if (!Object.keys(rejectionFields).length) {
      const rejectionData = await findQcRejection(id);
      return res.json({
        success: true,
        data: { rejection: rejectionData },
        message: "No change",
      });
    }

    await updateQcRejection(id, rejectionFields);

    const rejectionData = await findQcRejection(id);

    log(req, "approve", String(id), {
      qc_reject_uid: id,
      ipr_uid: rejectionData?.ipr_uid ?? null,
      out_uid: rejectionData?.out_uid ?? null,
      coil_count: rejectionData?.coil_count ?? null,
      approval_only: approvalOnly,
    }, rejectionData);

    return res.json({
      success: true,
      data: { rejection: rejectionData },
      message: "Rejection authorized. It will appear in Store Out → Pending.",
    });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({ success: false, message: err.message });
  }
};

export const deleteQcRejection = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_reject_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC rejection ID is required." });
    const existing = await findQcRejection(id);
    if (!existing) return res.status(404).json({ success: false, message: "QC rejection record not found." });

    if (String(existing.bill_no || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Completed rejection register entries cannot be deleted.",
      });
    }

    const activeOut = await findActiveStoreOutForRejection(existing);
    if (activeOut) {
      return res.status(400).json({
        success: false,
        message: `Store Out #${activeOut.out_uid} has started. Delete Store Out first.`,
      });
    }

    const user = auditUserName(req);
    if (existing.out_uid) {
      await updateQcRejection(id, {
        out_uid: null,
        updated_by: user,
        updated_at: new Date(),
      });
    }

    if (isMrnPortalRejectionRow(existing)) {
      const removed = await permanentlyRemoveUnusedMrnPortalRejection(existing);
      if (!removed.ok) {
        return res.status(400).json({ success: false, message: removed.message });
      }

      log(req, "delete", String(id), {
        qc_reject_uid: id,
        reason: existing.reason ?? null,
        permanent: true,
        mrn_uid: removed.mrn_uid,
        mrn_deleted: removed.mrn_deleted,
      }, existing);

      return res.json({
        success: true,
        message: "Rejection permanently deleted. MRN is back in ERP Pending.",
      });
    }

    const coils = await findCoils({ filters: { rm_uid: id }, limit: 5000 });
    await revertCoilsFromRejectionRegister(id, user);
    if (!existing.ipr_uid) {
      await reopenQcChecksForRejection(id, user);
    }
    await softDeleteQcRejection(id, user);

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.QC_REJECT_REVERT,
      source_module: "rm_rejection",
      source_id: String(id),
      user_name: user,
      user_id: req.user?.id,
      rows: coils.data || [],
      details: { qc_reject_uid: id, coil_count: coils.data?.length || 0, returned_to_pending: true },
    });
    log(req, "delete", String(id), {
      qc_reject_uid: id,
      coil_count: coils.data?.length || 0,
      reason: existing.reason ?? null,
    }, existing);

    return res.json({
      success: true,
      message: "Rejection register deleted. Item is back in Pending.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Save bill number(s) on an authorized QC rejection (same idea as IMS Forwarding Note).
 * First attach: add permission. Update / clear after attach: super_admin only.
 * body: { qc_reject_uid, bill_no, bill_dt? } — bill_no null/"" clears.
 */
export const updateQcRejectionBill = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_reject_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC rejection ID is required." });

    const existing = await findQcRejection(id);
    if (!existing) return res.status(404).json({ success: false, message: "QC rejection record not found." });
    const storeOutApproved = await hasApprovedRejectionStoreOut(id);
    if (!isMrnPortalRejectionRow(existing) && !storeOutApproved) {
      return res.status(400).json({
        success: false,
        message: "Complete Store Out authorization before saving a bill number.",
      });
    }

    const previous = existing.bill_no === null || existing.bill_no === undefined
        ? null
        : String(existing.bill_no).trim() || null;
    const previousDt = existing.bill_dt ? String(existing.bill_dt) : null;

    const bill_no =
      req.body?.bill_no === null || req.body?.bill_no === undefined
        ? null
        : String(req.body.bill_no).trim() || null;

    const bill_dt =
      req.body?.bill_dt === null || req.body?.bill_dt === undefined || req.body?.bill_dt === ""
        ? null
        : String(req.body.bill_dt).trim() || null;

    const isUpdate = Boolean(previous);
    const isClear = previous && !bill_no;
    const isSuperAdmin = String(req.user?.type || "").toLowerCase() === "super_admin" || String(req.user?.role || "").toLowerCase() === "super_admin";

    // IMS style: once bill is attached, only super admin can change / clear it.
    if ((isUpdate || isClear) && !isSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: "Bill already attached. Only Super Admin can update or clear it.",
      });
    }

    const editBlocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (editBlocked) {
      return res.status(editBlocked.status).json({ success: false, message: editBlocked.message });
    }

    if (previous === bill_no && previousDt === bill_dt) {
      return res.json({
        success: true,
        data: existing,
        message: "No change",
      });
    }

    const user = auditUserName(req);
    await updateQcRejection(id, {
      bill_no,
      bill_dt,
      updated_by: user,
      updated_at: new Date(),
    });

    const data = await findQcRejection(id);
    log(req, "update_bill", String(id), {
      qc_reject_uid: id,
      old_values: { bill_no: previous, bill_dt: previousDt },
      new_values: { bill_no, bill_dt },
    }, data);
    return res.json({
      success: true,
      data,
      message: data?.bill_no
        ? isUpdate
          ? "Bill number(s) updated successfully."
          : "Bill number(s) saved successfully."
        : "Bill number cleared successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

function normalizeImsBillNo(record) {
  const raw =
    record?.prnbillno ??
    record?.PrnBillNo ??
    record?.billno ??
    record?.bill_no ??
    record?.BillNo ??
    record?.DocNo ??
    "";
  return String(raw ?? "").trim();
}

/** IMS billdt e.g. `24-09-2026 10:17` or ISO → `YYYY-MM-DD`. */
function normalizeImsBillDt(record) {
  const raw = record?.billdt ?? record?.bill_dt ?? record?.BillDt ?? null;
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const dmy = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dmy) {
    const dd = dmy[1].padStart(2, "0");
    const mm = dmy[2].padStart(2, "0");
    return `${dmy[3]}-${mm}-${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function invfnoteItemCode(rec = {}) {
  return String(rec?.item_code ?? rec?.itemcode ?? "").trim() || null;
}

/** Live bills from IMS invfnote — only salecat=2. Optional filter: acc_code + item_code / item_dcode. */
export const getQcRejectionBillNumbersViews = async (req, res) => {
  try {
    const search = String(req.body?.search ?? "").trim().toLowerCase();
    const page = Math.max(1, Number(req.body?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.body?.limit) || 50));
    const filterAcc = String(req.body?.acc_code ?? "").trim() || null;
    const filterItemCode = normMatchKey(req.body?.item_code);
    const filterItemDcode = String(req.body?.item_dcode ?? req.body?.itemdcode ?? "").trim() || null;

    const records = await fetchFromIMS("invfnote");
    const seen = new Set();
    const rows = [];

    for (const rec of records || []) {
      if (invfnoteSaleCat(rec) !== "2") continue;

      const uidParts = invfnoteUidParts(rec);
      const acc_code = String(rec?.acc_code ?? uidParts.acc_code ?? "").trim() || null;
      const item_dcode = String(rec?.itemdcode ?? rec?.item_dcode ?? uidParts.item_dcode ?? "").trim() || null;
      const item_code = invfnoteItemCode(rec);

      if (filterAcc && String(filterAcc) !== String(acc_code)) continue;
      if (filterItemDcode || filterItemCode) {
        const dOk = filterItemDcode && item_dcode && String(filterItemDcode) === String(item_dcode);
        const cOk = filterItemCode && item_code && filterItemCode === normMatchKey(item_code);
        if (!dOk && !cOk) continue;
      }

      const billNo = normalizeImsBillNo(rec);
      if (!billNo || seen.has(billNo)) continue;
      seen.add(billNo);
      const bill_dt = normalizeImsBillDt(rec);
      const acc_name = String(rec?.acc_name ?? "").trim() || null;
      const status = String(rec?.status ?? "").trim() || null;
      if (
        search &&
        ![billNo, acc_name, item_code, bill_dt, status, acc_code]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(search)
      ) {
        continue;
      }
      rows.push({
        id: billNo,
        bill_no: billNo,
        billno: billNo,
        bill_dt,
        billdt: bill_dt,
        acc_code,
        acc_name,
        item_code,
        item_dcode,
        itemdcode: item_dcode,
        muid: String(rec?.muid ?? "").trim() || null,
        item_desc: String(rec?.item_desc ?? rec?.itemdesc ?? "").trim() || null,
        itqty: invfnoteQty(rec),
        status,
        is_green: String(status || "").toLowerCase() === "green",
        salecat: "2",
      });
    }

    rows.sort((a, b) =>
      String(a.bill_no).localeCompare(String(b.bill_no), undefined, { sensitivity: "base" })
    );

    const total = rows.length;
    const start = (page - 1) * limit;
    const data = rows.slice(start, start + limit);

    return res.json({ success: true, data, total });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Complete awaiting-bill rejection: bill_no + bill_dt (+ optional remarks).
 * Bill date comes from selected invfnote bill. Moves Pending → Register.
 * body: { qc_reject_uid, bill_no, bill_dt, remarks? }
 */
export const completeQcRejectionBill = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_reject_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC rejection ID is required." });

    const existing = await findQcRejection(id);
    if (!existing) return res.status(404).json({ success: false, message: "QC rejection record not found." });
    if (String(existing.bill_no || "").trim()) {
      return res.status(400).json({ success: false, message: "This rejection is already complete." });
    }

    const storeOutApproved = await hasApprovedRejectionStoreOut(id);
    if (!isMrnPortalRejectionRow(existing) && !storeOutApproved) {
      return res.status(400).json({
        success: false,
        message: "Complete Store Out authorization before attaching the bill.",
      });
    }

    const editBlocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (editBlocked) {
      return res.status(editBlocked.status).json({ success: false, message: editBlocked.message });
    }

    const bill_no = String(req.body?.bill_no ?? "").trim();
    if (!bill_no) {
      return res.status(400).json({ success: false, message: "Bill number is required." });
    }
    const bill_dt = String(req.body?.bill_dt ?? "").trim();
    if (!bill_dt) {
      return res.status(400).json({ success: false, message: "Bill date is required." });
    }

    const remarks =
      req.body?.remarks === undefined && req.body?.remark === undefined
        ? undefined
        : String(req.body?.remarks ?? req.body?.remark ?? "").trim() || null;

    const user = auditUserName(req);
    const fields = {
      bill_no,
      bill_dt,
      updated_by: user,
      updated_at: new Date(),
    };
    if (remarks !== undefined) fields.remarks = remarks;

    await updateQcRejection(id, fields);

    const data = await findQcRejection(id);
    log(req, "complete_bill", String(id), {
      qc_reject_uid: id,
      bill_no: data?.bill_no,
      bill_dt: data?.bill_dt,
    }, data);

    return res.json({
      success: true,
      data,
      message: "Bill saved. Rejection moved to Register.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
