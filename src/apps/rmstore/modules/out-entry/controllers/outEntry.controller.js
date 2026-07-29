import { findOutEntries, findOutEntry, insertOutEntry, updateOutEntry, softDeleteOutEntry, replaceOutEntryScannedCoils, findOutEntryScannedCoilUids, findOutEntryScannedCoilsDetailed, findOpenOutDraftForCoil, clearOutEntryScannedCoils, buildOutEntryCoilSummary, findStoredMrnSummaries, findStoredMrnDetail, findStoredPendingForOut } from "../models/outEntry.model.js";
import { findCoilByUid, updateCoilsAfterStoreOut, clearCoilsForStoreOut, clearCoilsForRejectionStoreOut, findCoils } from "../../coil/models/coil.model.js";
import { updateQcRejection, findQcRejection } from "../../qc-rejection/models/qcRejection.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { OUT_ENTRY_TYPE, normalizeOutEntryType, isRmRejectionOutEntry } from "../../../lib/constants/outEntryTypes.js";

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

export const getStoredCoilList = async (req, res) => {
  try {
    const { page, limit, search } = extractListParams(req.body || {}, { sortBy: "coil_uid", order: "DESC" });
    const expand_coils =
      req.body?.expand_coils === true ||
      req.body?.expand_coils === "true" ||
      req.body?.filters?.expand_coils === true ||
      req.body?.filters?.expand_coils === "true";
    const result = await findStoredPendingForOut({
      search: sanitizeSearch(search),
      page,
      limit: limit || 1000,
      expand_coils,
    });
    return res.json({ success: true, ...result });
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

    if (isRmRejectionOutEntry(entry_type)) {
      return res.status(400).json({
        success: false,
        message: "An RM Rejection Store Out must be generated from RM Rejection Pending.",
      });
    }

    if (normalizedApproved === true && !scan_complete) {
      return res.status(400).json({
        success: false,
        message: "Complete all coil scans before authorizing this store-out entry.",
      });
    }

    const { uids, resolved } = await resolveStoreOutCoils(coilInputs);
    const summary = buildOutEntryCoilSummary(resolved);
    const user = auditUserName(req);

    const row = await insertOutEntry({
      entry_type: OUT_ENTRY_TYPE.STORE_OUT,
      ...summary,
      remarks,
      created_by: user,
      scan_complete,
    });

    await replaceOutEntryScannedCoils(row.out_uid, uids);

    let willApprove = normalizedApproved === true && scan_complete;
    if (willApprove) {
      const fields = { scan_complete: true };
      applyApprovalWorkflow({
        req, fields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      await updateOutEntry(row.out_uid, fields);
      await updateCoilsAfterStoreOut(row.out_uid, uids, user);
      logCoilTransactionSafe({
        transaction_type: COIL_TX_TYPES.STORE_OUT,
        source_module: "out_entry",
        source_id: String(row.out_uid),
        user_name: user,
        user_id: req.user?.id,
        rows: resolved,
        details: { out_uid: row.out_uid, coil_count: resolved.length, entry_type: OUT_ENTRY_TYPE.STORE_OUT },
      });
    }

    const data = await loadOutEntryPayload(row.out_uid);
    const message = willApprove
      ? "Store Out authorized successfully."
      : scan_complete
        ? "Store Out submitted and is pending authorization."
        : "Store Out saved as a draft.";
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
            approved: false,
            approved_by: null,
            approved_at: null,
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

    if (hasCoilPayload && !isRmRejectionOutEntry(existing.entry_type)) {
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
      const fields = {
        remarks,
        updated_by: user,
        updated_at: new Date(),
      };
      if (incomingScanComplete !== undefined) {
        fields.scan_complete = scan_complete;
      }

      const hasBusinessChanges = String(remarks || "") !== String(existing.remarks || "");
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
    if (normalizedApproved === true && scan_complete && !isRmRejectionOutEntry(existing.entry_type)) {
      const linked = await findCoils({ filters: { out_uid: id }, limit: 5000 });
      const alreadyMoved = (linked.data || []).length > 0;
      if (!alreadyMoved) {
        const draftUids = uids || (await findOutEntryScannedCoilUids(id));
        if (!draftUids.length) {
          return res.status(400).json({ success: false, message: "There are no scanned coils to authorize." });
        }
        const recheck = await resolveStoreOutCoils(draftUids, { excludeOutUid: id });
        await updateCoilsAfterStoreOut(id, recheck.uids, user);
        logCoilTransactionSafe({
          transaction_type: COIL_TX_TYPES.STORE_OUT,
          source_module: "out_entry",
          source_id: String(id),
          user_name: user,
          user_id: req.user?.id,
          rows: recheck.resolved,
          details: { out_uid: id, coil_count: recheck.resolved.length, entry_type: OUT_ENTRY_TYPE.STORE_OUT },
        });
      }

      const approveFields = { remarks };
      applyApprovalWorkflow({
        req, fields: approveFields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      approveFields.scan_complete = true;
      approveFields.updated_by = user;
      approveFields.updated_at = new Date();
      await updateOutEntry(id, approveFields);
    }

    if (
      isRmRejectionOutEntry(existing.entry_type) &&
      existing.qc_reject_uid &&
      normalizedApproved !== undefined
    ) {
      const rejectionFields = {
        updated_by: user,
        updated_at: new Date(),
      };
      applyApprovalWorkflow({
        req,
        fields: rejectionFields,
        incomingApproved: normalizedApproved === true,
        hasBusinessChanges: false,
        auditAsName: true,
      });
      if (normalizedApproved !== true) {
        rejectionFields.approved = false;
        rejectionFields.approved_by = null;
        rejectionFields.approved_at = null;
      }
      await updateQcRejection(existing.qc_reject_uid, rejectionFields);

      if (normalizedApproved === true) {
        const approveFields = { remarks };
        applyApprovalWorkflow({
          req, fields: approveFields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
        });
        approveFields.scan_complete = true;
        approveFields.updated_by = user;
        approveFields.updated_at = new Date();
        await updateOutEntry(id, approveFields);
      }
    }

    const data = await loadOutEntryPayload(id);
    let message = "Store Out updated successfully.";
    if (data?.approved) message = "Store Out authorized successfully.";
    else if (isTruthyFlag(data?.scan_complete)) message = "Store Out submitted and is pending authorization.";
    else if (hasCoilPayload) message = "Store Out draft saved successfully.";

    return res.json({ success: true, data, message });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};
