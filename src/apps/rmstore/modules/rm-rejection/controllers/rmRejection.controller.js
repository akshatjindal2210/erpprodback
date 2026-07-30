import { findQcRejections, findQcRejection, insertQcRejection, updateQcRejection, softDeleteQcRejection } from "../models/rmRejection.model.js";
import { findInProcessRequest, findInProcessRejectionsPendingRejection, normalizeRequestType, IPR_DOWNSTREAM, IPR_REQUEST_TYPE, updateInProcessRequest } from "../../in-process-request/models/inProcessRequest.model.js";
import { findCoilByUid, updateCoilsAfterQcReject, updateCoilsAfterRejectionStoreOut, clearCoilsForQcReject, findCoils } from "../../coil/models/coil.model.js";
import { findQcCheck, findFailedQcChecksPendingRejection, reopenQcChecksForRejection, linkFailedQcChecksToRejection } from "../../qc-check/models/qcCheck.model.js";
import { insertOutEntry, findOutEntry, buildOutEntryCoilSummary } from "../../out-entry/models/outEntry.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { OUT_ENTRY_TYPE } from "../../../lib/constants/outEntryTypes.js";
import { fetchFromIMS } from "../../../../ims/lib/services/ims.service.js";

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
    ]);
    const status = String(safeFilters.status || "").trim().toLowerCase();

    // Pending = failed QC checks + approved in-process rejections (not yet in rejection register)
    if (status === "pending") {
      const [qcResult, iprResult] = await Promise.all([
        findFailedQcChecksPendingRejection({
          search: sanitizeSearch(search),
          page: 1,
          limit: 1000,
        }),
        findInProcessRejectionsPendingRejection({
          search: sanitizeSearch(search),
          page: 1,
          limit: 1000,
        }),
      ]);
      const merged = [...(iprResult.data || []), ...(qcResult.data || [])].sort((a, b) => {
        const ta = new Date(a.approved_at || a.inspected_at || a.created_at || 0).getTime();
        const tb = new Date(b.approved_at || b.inspected_at || b.created_at || 0).getTime();
        return tb - ta;
      });
      const safePage = Math.max(1, Number(page) || 1);
      const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
      const offset = (safePage - 1) * safeLimit;
      const data = merged.slice(offset, offset + safeLimit);
      const total = merged.length;
      return res.json({
        success: true,
        data,
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      });
    }

    const listFilters = { ...safeFilters };
    delete listFilters.status;
    if (status === "approved") listFilters.approved = true;
    else if (status === "unauthorized" || status === "register_pending") listFilters.approved = false;

    const result = await findQcRejections({
      filters: listFilters,
      search: sanitizeSearch(search),
      page,
      limit,
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
    const coils = await findCoils({ filters: { qc_reject_uid: id }, limit: 5000 });
    return res.json({ success: true, data: { ...data, coils: coils.data } });
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

    const mrnRefs = [...new Set(resolved.map((c) => c.mrn_no).filter((v) => v != null))].join(" | ");
    const heatNos = [...new Set(resolved.map((c) => c.heat_no).filter(Boolean))].join(" | ");
    const itemCodes = [...new Set(resolved.map((c) => c.item_code).filter(Boolean))].join(" | ");
    const total_qty = resolved.reduce((s, c) => s + (Number(c.qty) || 0), 0);
    const qtys = resolved.map((c) => c.qty ?? "").join(",");
    const user = auditUserName(req);

    const row = await insertQcRejection({
      mrn_refs: mrnRefs || null,
      heat_nos: heatNos || null,
      item_codes: itemCodes || null,
      qtys,
      total_qty,
      coil_count: resolved.length,
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
    const coils = await findCoils({ filters: { qc_reject_uid: row.qc_reject_uid }, limit: 5000 });
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

    const coil = await findCoilByUid(check.coil_no_uid);
    if (!coil) {
      return res.status(400).json({ success: false, message: `Coil ${check.coil_no_uid} was not found.` });
    }

    const row = await insertQcRejection({
      mrn_refs: check.mrn_no != null ? String(check.mrn_no) : null,
      heat_nos: check.heat_no || null,
      item_codes: check.item_code || null,
      qtys: String(check.qty ?? ""),
      total_qty: check.qty ?? 0,
      coil_count: 1,
      reason,
      remarks,
      created_by: user,
    });

    await updateCoilsAfterQcReject(row.qc_reject_uid, [check.coil_no_uid], user);
    await linkFailedQcChecksToRejection(row.qc_reject_uid, [check.coil_no_uid], user);

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
      rows: [coil],
      details: { qc_reject_uid: row.qc_reject_uid, qc_check_uid: id, reason, from_qc_check: true },
    });

    const data = await findQcRejection(row.qc_reject_uid);
    const coils = await findCoils({ filters: { qc_reject_uid: row.qc_reject_uid }, limit: 5000 });
    return res.status(201).json({
      success: true,
      data: { ...data, coils: coils.data },
      message: "Moved to the Rejection Register successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Pending failed QC → Rejection Register + Store Out (type RM Rejection).
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
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);
    const user = auditUserName(req);

    const coil = await findCoilByUid(check.coil_no_uid);
    if (!coil) {
      return res.status(400).json({ success: false, message: `Coil ${check.coil_no_uid} was not found.` });
    }
    const coilStatus = String(coil.status || "active").toLowerCase();
    const qcFailHeld =
      coilStatus === "rejected" &&
      !coil.qc_reject_uid &&
      !coil.out_uid &&
      (String(coil.qc_check_status || "").toLowerCase() === "failed" ||
        Number(coil.qc_check_uid) === id);
    if (coilStatus !== "active" && !qcFailHeld) {
      return res.status(400).json({
        success: false,
        message: `Coil ${check.coil_no_uid} is not available. Its current status is ${coilStatus}.`,
      });
    }
    if (coil.out_uid) {
      return res.status(400).json({
        success: false,
        message: `This coil is already linked to Store Out #${coil.out_uid}.`,
      });
    }

    const rejection = await insertQcRejection({
      mrn_refs: check.mrn_no != null ? String(check.mrn_no) : null,
      heat_nos: check.heat_no || null,
      item_codes: check.item_code || null,
      qtys: String(check.qty ?? ""),
      total_qty: check.qty ?? 0,
      coil_count: 1,
      reason,
      remarks,
      created_by: user,
    });

    const outRow = await insertOutEntry({
      entry_type: OUT_ENTRY_TYPE.RM_REJECTION,
      qc_reject_uid: rejection.qc_reject_uid,
      mrn_refs: check.mrn_no != null ? String(check.mrn_no) : null,
      heat_nos: check.heat_no || null,
      item_codes: check.item_code || null,
      qtys: String(check.qty ?? ""),
      total_qty: check.qty ?? 0,
      coil_count: 1,
      location_refs: coil.location_id != null ? String(coil.location_id) : null,
      remarks: remarks || reason,
      created_by: user,
      scan_complete: true,
    });

    await updateCoilsAfterRejectionStoreOut(
      outRow.out_uid,
      rejection.qc_reject_uid,
      [check.coil_no_uid],
      user,
      coil.ipr_uid != null ? { fromIprUid: coil.ipr_uid } : {}
    );
    await linkFailedQcChecksToRejection(rejection.qc_reject_uid, [check.coil_no_uid], user);
    await updateQcRejection(rejection.qc_reject_uid, {
      out_uid: outRow.out_uid,
      updated_by: user,
      updated_at: new Date().toISOString(),
    });

    if (normalizedApproved === true) {
      const fields = {};
      applyApprovalWorkflow({
        req, fields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      await updateQcRejection(rejection.qc_reject_uid, fields);
    }

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.QC_REJECT,
      source_module: "rm_rejection",
      source_id: String(rejection.qc_reject_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: [coil],
      details: {
        qc_reject_uid: rejection.qc_reject_uid,
        qc_check_uid: id,
        out_uid: outRow.out_uid,
        reason,
        from_qc_check: true,
        store_out: true,
      },
    });
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.STORE_OUT,
      source_module: "out_entry",
      source_id: String(outRow.out_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: [coil],
      details: {
        out_uid: outRow.out_uid,
        qc_reject_uid: rejection.qc_reject_uid,
        qc_check_uid: id,
        entry_type: OUT_ENTRY_TYPE.RM_REJECTION,
        coil_count: 1,
      },
    });

    const rejectionData = await findQcRejection(rejection.qc_reject_uid);
    const outData = await findOutEntry(outRow.out_uid);
    const coils = await findCoils({ filters: { out_uid: outRow.out_uid }, limit: 5000 });

    return res.status(201).json({
      success: true,
      data: {
        rejection: rejectionData,
        out_entry: { ...outData, coils: coils.data },
      },
      message: "Store Out created successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Approved in-process rejection → Rejection Register + Store Out (type RM Rejection).
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
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);
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
      if (status === "rejected" && Number(coil.ipr_uid) === id && !coil.qc_reject_uid) {
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
      heat_nos: summary.heat_nos,
      item_codes: summary.item_codes,
      qtys: summary.qtys,
      total_qty: summary.total_qty,
      coil_count: summary.coil_count,
      reason,
      remarks,
      created_by: user,
    });

    const outRow = await insertOutEntry({
      entry_type: OUT_ENTRY_TYPE.RM_REJECTION,
      qc_reject_uid: rejection.qc_reject_uid,
      mrn_refs: summary.mrn_refs,
      heat_nos: summary.heat_nos,
      item_codes: summary.item_codes,
      qtys: summary.qtys,
      total_qty: summary.total_qty,
      coil_count: summary.coil_count,
      location_refs: summary.location_refs,
      remarks: remarks || reason,
      created_by: user,
      scan_complete: true,
    });

    await updateCoilsAfterRejectionStoreOut(
      outRow.out_uid,
      rejection.qc_reject_uid,
      coilUids,
      user,
      { fromIprUid: id }
    );
    await updateQcRejection(rejection.qc_reject_uid, {
      out_uid: outRow.out_uid,
      updated_by: user,
      updated_at: new Date().toISOString(),
    });
    await updateInProcessRequest(id, { downstream: IPR_DOWNSTREAM.STORE_OUT_DONE });

    if (normalizedApproved === true) {
      const fields = {};
      applyApprovalWorkflow({
        req, fields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      await updateQcRejection(rejection.qc_reject_uid, fields);
    }

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
        out_uid: outRow.out_uid,
        reason,
        rejection_type: ipr.rejection_type || null,
        coil_count: resolved.length,
        from_in_process: true,
        store_out: true,
      },
    });
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.STORE_OUT,
      source_module: "out_entry",
      source_id: String(outRow.out_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: resolved,
      details: {
        out_uid: outRow.out_uid,
        qc_reject_uid: rejection.qc_reject_uid,
        ipr_uid: id,
        entry_type: OUT_ENTRY_TYPE.RM_REJECTION,
        coil_count: resolved.length,
      },
    });

    const rejectionData = await findQcRejection(rejection.qc_reject_uid);
    const outData = await findOutEntry(outRow.out_uid);
    const coils = await findCoils({ filters: { out_uid: outRow.out_uid }, limit: 5000 });

    return res.status(201).json({
      success: true,
      data: {
        rejection: rejectionData,
        out_entry: { ...outData, coils: coils.data },
        ipr_uid: id,
      },
      message: "Store Out created from in-process rejection successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteQcRejection = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_reject_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC rejection ID is required." });
    const existing = await findQcRejection(id);
    if (!existing) return res.status(404).json({ success: false, message: "QC rejection record not found." });
    if (existing.out_uid) {
      return res.status(400).json({
        success: false,
        message: `This record is linked to Store Out #${existing.out_uid}. Delete that Store Out first.`,
      });
    }
    const user = auditUserName(req);
    const coils = await findCoils({ filters: { qc_reject_uid: id }, limit: 5000 });
    await clearCoilsForQcReject(id, user);
    await reopenQcChecksForRejection(id, user);
    await softDeleteQcRejection(id, user);

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.QC_REJECT_REVERT,
      source_module: "rm_rejection",
      source_id: String(id),
      user_name: user,
      user_id: req.user?.id,
      rows: coils.data || [],
      details: { qc_reject_uid: id, coil_count: coils.data?.length || 0 },
    });

    return res.json({ success: true, message: "QC rejection deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Save bill number(s) on an authorized QC rejection (same idea as IMS Forwarding Note).
 * body: { qc_reject_uid, bill_no } — bill_no null/"" clears.
 */
export const updateQcRejectionBill = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_reject_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC rejection ID is required." });

    const existing = await findQcRejection(id);
    if (!existing) return res.status(404).json({ success: false, message: "QC rejection record not found." });
    if (!existing.approved) {
      return res.status(400).json({
        success: false,
        message: "Authorize the linked Store Out before saving a bill number.",
      });
    }

    const bill_no =
      req.body?.bill_no === null || req.body?.bill_no === undefined
        ? null
        : String(req.body.bill_no).trim() || null;

    const user = auditUserName(req);
    await updateQcRejection(id, {
      bill_no,
      updated_by: user,
      updated_at: new Date(),
    });

    const data = await findQcRejection(id);
    return res.json({
      success: true,
      data,
      message: data?.bill_no ? "Bill number saved successfully." : "Bill number cleared successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

function normalizeImsBillNo(record) {
  const raw =
    record?.prnbillno ??
    record?.PrnBillNo ??
    record?.bill_no ??
    record?.billno ??
    "";
  return String(raw ?? "").trim();
}

/** Live bill numbers from IMS (`requestedData: "billno"`). */
export const getQcRejectionBillNumbersViews = async (req, res) => {
  try {
    const search = String(req.body?.search ?? "").trim().toLowerCase();
    const page = Math.max(1, Number(req.body?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.body?.limit) || 50));

    const records = await fetchFromIMS("billno");
    const seen = new Set();
    const rows = [];

    for (const rec of records) {
      const billNo = normalizeImsBillNo(rec);
      if (!billNo || seen.has(billNo)) continue;
      seen.add(billNo);
      if (search && !billNo.toLowerCase().includes(search)) continue;
      rows.push({ id: billNo, bill_no: billNo });
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
