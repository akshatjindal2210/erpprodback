import { findOutEntries, findOutEntry, insertOutEntry, updateOutEntry, softDeleteOutEntry, replaceOutEntryScannedCoils, findOutEntryScannedCoilUids, findOutEntryScannedCoilsDetailed, findOpenOutDraftForCoil, clearOutEntryScannedCoils, buildOutEntryCoilSummary, findStoredMrnSummaries, findStoredMrnDetail, findPendingStoreOutByJobCard, findPendingRejectionStoreOut, isCoilPendingJobCardStoreOut } from "../models/outEntry.model.js";
import { findCoilByUid, updateCoilsAfterStoreOut, updateCoilsAfterJobCardStoreOut, updateCoilsAfterRejectionStoreOut, clearCoilsForStoreOut, clearCoilsForRejectionStoreOut, findCoils } from "../../coil/models/coil.model.js";
import { updateQcRejection, findQcRejection } from "../../rm-rejection/models/rmRejection.model.js";
import { updateInProcessRequest, IPR_DOWNSTREAM } from "../../in-process-request/models/inProcessRequest.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { OUT_ENTRY_TYPE, normalizeOutEntryType, isRmRejectionOutEntry, isJobCardOutEntry } from "../../../lib/constants/outEntryTypes.js";

const MODULE = "rm_out_entry";
const log = createRmstoreActivityLogger(MODULE);

function isTruthyFlag(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

async function resolveStoreOutCoils(coilInputs, { excludeOutUid = null } = {}) {
  const uids = coilInputs
    .map((c) => (typeof c === "string" ? c.trim() : String(c?.coil_no_uid || "").trim()))
    .filter(Boolean);

  if (!uids.length) {
    const err = new Error("At least one coil is required.");
    err.statusCode = 400;
    throw err;
  }

  const resolved = [];
  for (const uid of uids) {
    const coil = await findCoilByUid(uid);
    if (!coil) {
      const err = new Error(`Coil ${uid} was not found.`);
      err.statusCode = 400;
      throw err;
    }
    const status = String(coil.status || "active").toLowerCase();
    if (status !== "active") {
      const err = new Error(`Coil ${uid} is not available. Its current status is ${status}.`);
      err.statusCode = 400;
      throw err;
    }
    if (!coil.location_id) {
      const err = new Error(`Coil ${uid} is not currently in store.`);
      err.statusCode = 400;
      throw err;
    }
    const openDraft = await findOpenOutDraftForCoil(uid, excludeOutUid);
    if (openDraft) {
      const err = new Error(`Coil ${uid} is already on Store Out draft OUT-${openDraft.out_uid}.`);
      err.statusCode = 400;
      throw err;
    }
    resolved.push(coil);
  }
  return { uids, resolved };
}

async function resolveJobCardStoreOutCoils(coilInputs, { excludeOutUid = null } = {}) {
  const uids = coilInputs
    .map((c) => (typeof c === "string" ? c.trim() : String(c?.coil_no_uid || "").trim()))
    .filter(Boolean);

  if (!uids.length) {
    const err = new Error("At least one coil is required.");
    err.statusCode = 400;
    throw err;
  }

  const resolved = [];
  for (const uid of uids) {
    const coil = await findCoilByUid(uid);
    if (!coil) {
      const err = new Error(`Coil ${uid} was not found.`);
      err.statusCode = 400;
      throw err;
    }
    const status = String(coil.status || "active").toLowerCase();
    if (status !== "active") {
      const err = new Error(`Coil ${uid} is not available. Its current status is ${status}.`);
      err.statusCode = 400;
      throw err;
    }
    const eligible = await isCoilPendingJobCardStoreOut(uid, excludeOutUid);
    if (!eligible) {
      const err = new Error(
        `Coil ${uid} is not on an approved job card pending for Store Out.`
      );
      err.statusCode = 400;
      throw err;
    }
    const openDraft = await findOpenOutDraftForCoil(uid, excludeOutUid);
    if (openDraft) {
      const err = new Error(`Coil ${uid} is already on Store Out draft OUT-${openDraft.out_uid}.`);
      err.statusCode = 400;
      throw err;
    }
    resolved.push(coil);
  }
  return { uids, resolved };
}

async function resolveRejectionStoreOutCoils(coilInputs, { qcRejectUid, excludeOutUid = null } = {}) {
  const rejectId = Number(qcRejectUid);
  if (!Number.isFinite(rejectId) || rejectId <= 0) {
    const err = new Error("Rejection register link is missing on this store-out entry.");
    err.statusCode = 400;
    throw err;
  }

  const uids = coilInputs
    .map((c) => (typeof c === "string" ? c.trim() : String(c?.coil_no_uid || "").trim()))
    .filter(Boolean);

  if (!uids.length) {
    const err = new Error("At least one coil is required.");
    err.statusCode = 400;
    throw err;
  }

  const resolved = [];
  for (const uid of uids) {
    const coil = await findCoilByUid(uid);
    if (!coil) {
      const err = new Error(`Coil ${uid} was not found.`);
      err.statusCode = 400;
      throw err;
    }
    const status = String(coil.status || "active").toLowerCase();
    const linkedReject = Number(coil.qc_reject_uid);
    if (linkedReject !== rejectId) {
      const err = new Error(`Coil ${uid} is not linked to rejection register #${rejectId}.`);
      err.statusCode = 400;
      throw err;
    }
    if (status !== "active" && status !== "rejected") {
      const err = new Error(`Coil ${uid} is not available. Its current status is ${status}.`);
      err.statusCode = 400;
      throw err;
    }
    if (status === "active" && !coil.location_id) {
      const err = new Error(`Coil ${uid} is not currently in store.`);
      err.statusCode = 400;
      throw err;
    }
    const openDraft = await findOpenOutDraftForCoil(uid, excludeOutUid);
    if (openDraft) {
      const err = new Error(`Coil ${uid} is already on Store Out draft OUT-${openDraft.out_uid}.`);
      err.statusCode = 400;
      throw err;
    }
    resolved.push(coil);
  }
  return { uids, resolved };
}

async function loadOutEntryPayload(out_uid) {
  const data = await findOutEntry(out_uid);
  if (!data) return null;

  const linked = await findCoils({ filters: { out_uid }, limit: 5000 });
  let coils = linked.data || [];
  if (!coils.length) {
    coils = await findOutEntryScannedCoilsDetailed(out_uid);
  }
  return { ...data, coils };
}

export const getOutEntries = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "out_uid",
      order: "DESC",
    });
    const result = await findOutEntries({
      filters: sanitizeFilters(filters || {}, [
        "approved",
        "scan_complete",
        "from_date",
        "to_date",
        "entry_type",
        "qc_reject_uid",
      ]),
      search: sanitizeSearch(search),
      page,
      limit,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

function normalizePendingStoreOutRow(row) {
  const type = String(row?.pending_type || "").toLowerCase();
  return {
    ...row,
    pending_type: type === "rejection" ? "rejection" : "job_card",
    sort_at: row?.sort_at || row?.approved_at || row?.created_at || null,
  };
}

/** Unified Store Out pending — job cards + RM rejection in one response. */
export const getPendingStoreOutList = async (req, res) => {
  try {
    const { page, limit, search, filters } = extractListParams(req.body || {}, {
      sortBy: "sort_at",
      order: "DESC",
    });
    const pendingType = String(filters?.pending_type || filters?.pendingType || "all").toLowerCase();
    const searchOpt = sanitizeSearch(search);
    const wantJobCard = pendingType === "all" || pendingType === "job_card";
    const wantRejection = pendingType === "all" || pendingType === "rejection";

    const [jcResult, rejResult] = await Promise.all([
      wantJobCard
        ? findPendingStoreOutByJobCard({ search: searchOpt, page: 1, limit: 5000 })
        : Promise.resolve({ data: [] }),
      wantRejection
        ? findPendingRejectionStoreOut({ search: searchOpt, page: 1, limit: 5000 })
        : Promise.resolve({ data: [] }),
    ]);

    const merged = [...(jcResult.data || []), ...(rejResult.data || [])]
      .map(normalizePendingStoreOutRow)
      .sort((a, b) => {
        const ta = new Date(a.sort_at || 0).getTime();
        const tb = new Date(b.sort_at || 0).getTime();
        if (tb !== ta) return tb - ta;
        return String(b.issue_uid || b.out_uid || "").localeCompare(String(a.issue_uid || a.out_uid || ""));
      });

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
    const offset = (safePage - 1) * safeLimit;
    const data = merged.slice(offset, offset + safeLimit);
    const total = merged.length;

    return res.json({
      success: true,
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** MRNs with stored coils — Store Out picker (IMS FUID-style). */
export const getStoredMrnList = async (req, res) => {
  try {
    const { page, limit, search } = extractListParams(req.body || {}, { sortBy: "mrn_no", order: "DESC" });
    const result = await findStoredMrnSummaries({
      search: sanitizeSearch(search),
      page,
      limit: limit || 50,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** One MRN pick plan: locations + coils + sticker_mode. */
export const getStoredMrnDetail = async (req, res) => {
  try {
    const mrn_uid = String(req.body?.mrn_uid ?? req.body?.id ?? "").trim();
    if (!mrn_uid) {
      return res.status(400).json({ success: false, message: "MRN UID is required." });
    }
    const data = await findStoredMrnDetail(mrn_uid);
    if (!data || !data.coil_count) {
      return res.status(404).json({
        success: false,
        message: "No stored coils were found for this MRN.",
      });
    }
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getOutEntryById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.out_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid store-out entry ID is required." });
    const data = await loadOutEntryPayload(id);
    if (!data) return res.status(404).json({ success: false, message: "Store-out entry not found." });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Create Store Out from scanned stored coils.
 * body: { coils: [{ coil_no_uid }], remarks, approved, scan_complete?, entry_type? }
 * - scan_complete=false (default): draft — coils stay in store
 * - scan_complete=true: submitted pending authorize — coils stay in store until approve
 * - approved=true only allowed when scan_complete=true (moves stock)
 */
export const createOutEntry = async (req, res) => {
  try {
    const coilInputs = Array.isArray(req.body?.coils) ? req.body.coils : [];
    const remarks = req.body?.remarks != null ? String(req.body.remarks).trim() : null;
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);
    const entry_type = normalizeOutEntryType(req.body?.entry_type);
    const scan_complete =
      req.body?.scan_complete !== undefined ? isTruthyFlag(req.body.scan_complete) : false;

    if (normalizedApproved === true && !scan_complete) {
      return res.status(400).json({
        success: false,
        message: "Complete all coil scans before authorizing this store-out entry.",
      });
    }

    const user = auditUserName(req);
    let uids;
    let resolved;
    let savedEntryType = OUT_ENTRY_TYPE.STORE_OUT;
    let qcRejectUid = null;

    if (isRmRejectionOutEntry(entry_type)) {
      qcRejectUid = parsePositiveIntId(req.body?.qc_reject_uid);
      if (!qcRejectUid) {
        return res.status(400).json({
          success: false,
          message: "A valid QC rejection ID is required for RM Rejection Store Out.",
        });
      }

      const rejection = await findQcRejection(qcRejectUid);
      if (!rejection) {
        return res.status(404).json({ success: false, message: "QC rejection record not found." });
      }
      if (rejection.approved !== true) {
        return res.status(400).json({
          success: false,
          message: "Authorize the RM Rejection register before opening Store Out.",
        });
      }
      if (rejection.out_uid) {
        const existingOut = await findOutEntry(rejection.out_uid);
        if (existingOut && !existingOut.is_deleted) {
          return res.status(400).json({
            success: false,
            message: `Store Out draft OUT-${rejection.out_uid} already exists for this rejection.`,
          });
        }
      }

      ({ uids, resolved } = await resolveRejectionStoreOutCoils(coilInputs, { qcRejectUid }));
      savedEntryType = OUT_ENTRY_TYPE.RM_REJECTION;
    } else if (isJobCardOutEntry(entry_type)) {
      ({ uids, resolved } = await resolveJobCardStoreOutCoils(coilInputs));
      savedEntryType = OUT_ENTRY_TYPE.JOB_CARD;
    } else {
      ({ uids, resolved } = await resolveStoreOutCoils(coilInputs));
    }

    const summary = buildOutEntryCoilSummary(resolved);

    const row = await insertOutEntry({
      entry_type: savedEntryType,
      ...(qcRejectUid != null ? { qc_reject_uid: qcRejectUid } : {}),
      ...summary,
      remarks,
      created_by: user,
      scan_complete,
    });

    await replaceOutEntryScannedCoils(row.out_uid, uids);

    if (qcRejectUid != null) {
      await updateQcRejection(qcRejectUid, {
        out_uid: row.out_uid,
        updated_by: user,
        updated_at: new Date().toISOString(),
      });
    }

    let willApprove = normalizedApproved === true && scan_complete;
    if (willApprove) {
      const fields = { scan_complete: true };
      applyApprovalWorkflow({
        req, fields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      await updateOutEntry(row.out_uid, fields);

      if (isRmRejectionOutEntry(savedEntryType)) {
        const rejection = await findQcRejection(qcRejectUid);
        await updateCoilsAfterRejectionStoreOut(
          row.out_uid,
          qcRejectUid,
          uids,
          user,
          rejection?.ipr_uid ? { fromIprUid: rejection.ipr_uid } : {}
        );
        if (rejection?.ipr_uid) {
          await updateInProcessRequest(rejection.ipr_uid, { downstream: IPR_DOWNSTREAM.STORE_OUT_DONE });
        }
      } else if (isJobCardOutEntry(savedEntryType)) {
        await updateCoilsAfterJobCardStoreOut(row.out_uid, uids, user);
      } else {
        await updateCoilsAfterStoreOut(row.out_uid, uids, user);
      }

      logCoilTransactionSafe({
        transaction_type: COIL_TX_TYPES.STORE_OUT,
        source_module: "out_entry",
        source_id: String(row.out_uid),
        user_name: user,
        user_id: req.user?.id,
        rows: resolved,
        details: {
          out_uid: row.out_uid,
          coil_count: resolved.length,
          entry_type: savedEntryType,
          qc_reject_uid: qcRejectUid,
        },
      });
    }

    const data = await loadOutEntryPayload(row.out_uid);
    const message = willApprove
      ? "Store Out authorized successfully."
      : scan_complete
        ? "Store Out submitted and is pending authorization."
        : "Store Out saved as a draft.";
    log(req, willApprove ? "create_approve" : scan_complete ? "create_submit" : "create_draft", String(row.out_uid), {
      out_uid: row.out_uid,
      entry_type: savedEntryType,
      qc_reject_uid: qcRejectUid,
      coil_count: resolved.length,
      coil_no_uids: uids,
      scan_complete,
      approved: willApprove,
      remarks,
    }, data);
    return res.status(201).json({ success: true, data, message });
  } catch (err) {
    if (err?.statusCode === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteOutEntry = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.out_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid store-out entry ID is required." });
    const existing = await findOutEntry(id);
    if (!existing) return res.status(404).json({ success: false, message: "Store-out entry not found." });
    const user = auditUserName(req);
    const coils = await findCoils({ filters: { out_uid: id }, limit: 5000 });
    const isRejectionOut = isRmRejectionOutEntry(existing.entry_type);
    const stockMoved = (coils.data || []).length > 0;

    if (isRejectionOut) {
      await clearCoilsForRejectionStoreOut(id, user);
      if (existing.qc_reject_uid) {
        const rejection = await findQcRejection(existing.qc_reject_uid);
        if (rejection) {
          await updateQcRejection(existing.qc_reject_uid, {
            out_uid: null,
            updated_by: user,
            updated_at: new Date().toISOString(),
          });
        }
      }
    } else if (stockMoved) {
      await clearCoilsForStoreOut(id, user);
    }

    await clearOutEntryScannedCoils(id);
    await softDeleteOutEntry(id, user);

    if (stockMoved || isRejectionOut) {
      logCoilTransactionSafe({
        transaction_type: COIL_TX_TYPES.STORE_OUT_REVERT,
        source_module: "out_entry",
        source_id: String(id),
        user_name: user,
        user_id: req.user?.id,
        rows: coils.data || [],
        details: {
          out_uid: id,
          coil_count: coils.data?.length || 0,
          entry_type: existing.entry_type || OUT_ENTRY_TYPE.STORE_OUT,
          qc_reject_uid: existing.qc_reject_uid || null,
        },
      });
    }

    log(req, "delete", String(id), {
      out_uid: id,
      entry_type: existing.entry_type || OUT_ENTRY_TYPE.STORE_OUT,
      qc_reject_uid: existing.qc_reject_uid ?? null,
      coil_count: coils.data?.length || 0,
      stock_moved: stockMoved,
    }, existing);

    return res.json({ success: true, message: "Store Out deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Update draft/pending Store Out (coils + remarks + scan_complete) or approve.
 * body: { out_uid, coils?, remarks?, approved?, scan_complete? }
 */
export const updateOutEntryCtrl = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.out_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid store-out entry ID is required." });

    const existing = await findOutEntry(id);
    if (!existing) return res.status(404).json({ success: false, message: "Store-out entry not found." });

    const user = auditUserName(req);
    const remarks =
      req.body?.remarks !== undefined
        ? req.body.remarks != null
          ? String(req.body.remarks).trim()
          : null
        : existing.remarks;

    const normalizedApproved =
      req.body?.approved !== undefined ? normalizeApprovedInput(req.body.approved) : undefined;

    const hasCoilPayload = Array.isArray(req.body?.coils);
    const incomingScanComplete =
      req.body?.scan_complete !== undefined ? isTruthyFlag(req.body.scan_complete) : undefined;

    const alreadyApproved = isTruthyFlag(existing.approved);
    if (alreadyApproved && (hasCoilPayload || incomingScanComplete === false)) {
      return res.status(400).json({
        success: false,
        message: "The scanned coils cannot be changed once the Store Out is authorized.",
      });
    }

    let uids = null;
    let scan_complete =
      incomingScanComplete !== undefined
        ? incomingScanComplete
        : isTruthyFlag(existing.scan_complete);

    if (normalizedApproved === true && !scan_complete) {
      return res.status(400).json({
        success: false,
        message: "Complete all coil scans before authorizing this store-out entry.",
      });
    }

    if (hasCoilPayload && isRmRejectionOutEntry(existing.entry_type)) {
      const result = await resolveRejectionStoreOutCoils(req.body.coils, {
        qcRejectUid: existing.qc_reject_uid,
        excludeOutUid: id,
      });
      uids = result.uids;
      const summary = buildOutEntryCoilSummary(result.resolved);
      await replaceOutEntryScannedCoils(id, uids);
      await updateOutEntry(id, {
        ...summary,
        remarks,
        scan_complete,
        updated_by: user,
        updated_at: new Date(),
      });
    } else if (hasCoilPayload && isJobCardOutEntry(existing.entry_type)) {
      const result = await resolveJobCardStoreOutCoils(req.body.coils, { excludeOutUid: id });
      uids = result.uids;
      const summary = buildOutEntryCoilSummary(result.resolved);
      await replaceOutEntryScannedCoils(id, uids);
      await updateOutEntry(id, {
        ...summary,
        remarks,
        scan_complete,
        updated_by: user,
        updated_at: new Date(),
      });
    } else if (hasCoilPayload && !isRmRejectionOutEntry(existing.entry_type)) {
      const result = await resolveStoreOutCoils(req.body.coils, { excludeOutUid: id });
      uids = result.uids;
      const summary = buildOutEntryCoilSummary(result.resolved);
      await replaceOutEntryScannedCoils(id, uids);
      await updateOutEntry(id, {
        ...summary,
        remarks,
        scan_complete,
        updated_by: user,
        updated_at: new Date(),
      });
    } else {
      const fields = { remarks };
      if (incomingScanComplete !== undefined) {
        fields.scan_complete = scan_complete;
      }

      const hasBusinessChanges =
        String(remarks || "") !== String(existing.remarks || "") ||
        (incomingScanComplete !== undefined &&
          scan_complete !== isTruthyFlag(existing.scan_complete));
      if (hasBusinessChanges) {
        fields.updated_by = user;
        fields.updated_at = new Date();
      }
      const shouldPersist =
        hasBusinessChanges ||
        incomingScanComplete !== undefined ||
        (normalizedApproved !== undefined && isRmRejectionOutEntry(existing.entry_type));

      if (shouldPersist && normalizedApproved !== true) {
        if (normalizedApproved === false || hasBusinessChanges) {
          applyApprovalWorkflow({
            req,
            fields,
            incomingApproved: normalizedApproved === false ? false : undefined,
            hasBusinessChanges: hasBusinessChanges && normalizedApproved !== true,
            auditAsName: true,
          });
        }
        await updateOutEntry(id, fields);
      } else if (shouldPersist) {
        await updateOutEntry(id, fields);
      }
    }

    // Approve path — move stock for store_out when not yet moved
    if (
      normalizedApproved === true &&
      scan_complete &&
      !isRmRejectionOutEntry(existing.entry_type)
    ) {
      const linked = await findCoils({ filters: { out_uid: id }, limit: 5000 });
      const alreadyMoved = (linked.data || []).length > 0;
      if (!alreadyMoved) {
        const draftUids = uids || (await findOutEntryScannedCoilUids(id));
        if (!draftUids.length) {
          return res.status(400).json({ success: false, message: "There are no scanned coils to authorize." });
        }
        const recheck = isJobCardOutEntry(existing.entry_type)
          ? await resolveJobCardStoreOutCoils(draftUids, { excludeOutUid: id })
          : await resolveStoreOutCoils(draftUids, { excludeOutUid: id });
        if (isJobCardOutEntry(existing.entry_type)) {
          await updateCoilsAfterJobCardStoreOut(id, recheck.uids, user);
        } else {
          await updateCoilsAfterStoreOut(id, recheck.uids, user);
        }
        logCoilTransactionSafe({
          transaction_type: COIL_TX_TYPES.STORE_OUT,
          source_module: "out_entry",
          source_id: String(id),
          user_name: user,
          user_id: req.user?.id,
          rows: recheck.resolved,
          details: {
            out_uid: id,
            coil_count: recheck.resolved.length,
            entry_type: existing.entry_type || OUT_ENTRY_TYPE.STORE_OUT,
          },
        });
      }

      const approveFields = { remarks };
      applyApprovalWorkflow({
        req, fields: approveFields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      approveFields.scan_complete = true;
      await updateOutEntry(id, approveFields);
    }

    if (
      isRmRejectionOutEntry(existing.entry_type) &&
      existing.qc_reject_uid &&
      normalizedApproved === true &&
      scan_complete
    ) {
      const rejection = await findQcRejection(existing.qc_reject_uid);
      const linked = await findCoils({ filters: { out_uid: id }, limit: 5000 });
      const alreadyMoved = (linked.data || []).length > 0;
      if (!alreadyMoved) {
        const draftUids = await findOutEntryScannedCoilUids(id);
        if (!draftUids.length) {
          return res.status(400).json({ success: false, message: "There are no scanned coils to authorize." });
        }
        await updateCoilsAfterRejectionStoreOut(
          id,
          existing.qc_reject_uid,
          draftUids,
          user,
          rejection?.ipr_uid ? { fromIprUid: rejection.ipr_uid } : {}
        );
        const movedCoils = await findCoils({ filters: { out_uid: id }, limit: 5000 });
        logCoilTransactionSafe({
          transaction_type: COIL_TX_TYPES.STORE_OUT,
          source_module: "out_entry",
          source_id: String(id),
          user_name: user,
          user_id: req.user?.id,
          rows: movedCoils.data || [],
          details: {
            out_uid: id,
            qc_reject_uid: existing.qc_reject_uid,
            entry_type: OUT_ENTRY_TYPE.RM_REJECTION,
            coil_count: draftUids.length,
          },
        });
      }
      if (rejection?.ipr_uid) {
        await updateInProcessRequest(rejection.ipr_uid, { downstream: IPR_DOWNSTREAM.STORE_OUT_DONE });
      }
      const approveFields = { remarks };
      applyApprovalWorkflow({
        req, fields: approveFields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      approveFields.scan_complete = true;
      await updateOutEntry(id, approveFields);
    }

    const data = await loadOutEntryPayload(id);
    let message = "Store Out updated successfully.";
    if (data?.approved) message = "Store Out authorized successfully.";
    else if (isTruthyFlag(data?.scan_complete)) message = "Store Out submitted and is pending authorization.";
    else if (hasCoilPayload) message = "Store Out draft saved successfully.";

    log(req, data?.approved ? "approve" : isTruthyFlag(data?.scan_complete) ? "submit" : "update", String(id), {
      out_uid: id,
      entry_type: existing.entry_type || OUT_ENTRY_TYPE.STORE_OUT,
      qc_reject_uid: existing.qc_reject_uid ?? null,
      coil_count: data?.coils?.length ?? data?.scanned_coils?.length ?? null,
      scan_complete: isTruthyFlag(data?.scan_complete),
      approved: data?.approved === true,
      remarks,
    }, data);

    return res.json({ success: true, data, message });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};
