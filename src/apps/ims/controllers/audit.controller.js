import { findAudits, findAudit, insertAudit, updateAudit, deleteAudit, appendAuditScannedBoxes, deleteAuditScan, evaluateAuditLocationProgress, syncAuditMasterStatus, getAuditComparisonReport, reopenAuditLocation, reassignAuditLocation, applyAuditComparisonAdjustment, completeAuditLocation, getAuditLocationScores } from "../models/audit.model.js";
import { logActivity } from "../utils/activityLogger.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../utils/approval.js";
import { withTransaction } from "../../../config/db.js";
import { canAccessAuditRecord, filterAuditLocationsForUser, isWithinAuditDateRange } from "../utils/auditAccess.js";
import { isLocationClosed } from "../utils/auditBoxSnapshot.js";

const CFG = getCrudModuleConfig("audit");

const log = (req, action, entity_id, details, record = null) =>
  logActivity(req, {
    action,
    entity: "audit",
    entity_id,
    details,
    record,
  }).catch(() => {});

function validateAuditAssignments(assignments) {
  if (!Array.isArray(assignments) || !assignments.length) {
    return { ok: false, message: "At least one assignment row required" };
  }

  const seenUsers = new Set();
  const seenLocations = new Set();

  for (const row of assignments) {
    if (!row?.assigned_user_id) {
      return { ok: false, message: "Each row must have an assigned user" };
    }
    const userKey = String(row.assigned_user_id);
    if (seenUsers.has(userKey)) {
      return { ok: false, message: "Duplicate user in assignment rows" };
    }
    seenUsers.add(userKey);

    const locIds = Array.isArray(row.location_ids) ? row.location_ids : [];
    if (!locIds.length) {
      return { ok: false, message: "Each user must have at least one location" };
    }
    for (const locId of locIds) {
      const locKey = String(locId);
      if (seenLocations.has(locKey)) {
        return { ok: false, message: "Same location cannot be assigned to multiple users" };
      }
      seenLocations.add(locKey);
    }
  }

  return { ok: true };
}

export const getAudits = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "audit_id", order: "DESC" });

    const result = await findAudits({
      filters: sanitizeFilters(filters, CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: CFG.listFields,
      permission: req.permission,
      user: req.user
    });

    const data = (result.data || []).map((row) =>
      filterAuditLocationsForUser(row, req.user, req.permission)
    );

    return res.json({ success: true, ...result, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getAuditById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const data = await findAudit({ audit_id: id });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });

    if (!canAccessAuditRecord(data, req.user, req.permission)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    return res.json({
      success: true,
      data: filterAuditLocationsForUser(data, req.user, req.permission),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createAudit = async (req, res) => {
  try {
    const { start_date, end_date, remarks, assignments, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved ?? false);

    if (!start_date) return res.status(400).json({ success: false, message: "start_date required" });
    if (!end_date) return res.status(400).json({ success: false, message: "end_date required" });

    const hasAssignments = Array.isArray(assignments) && assignments.length > 0;
    if (!hasAssignments) {
      return res.status(400).json({ success: false, message: "At least one user assignment row required" });
    }

    const validation = validateAuditAssignments(assignments);
    if (!validation.ok) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    const approvalFields = {};
    applyApprovalWorkflow({
      req,
      fields: approvalFields,
      incomingApproved: normalizedApproved,
      hasBusinessChanges: false,
    });

    const row = await withTransaction(async (client) => {
      const audit = await insertAudit({
        start_date,
        end_date,
        remarks,
        assignments,
        created_by: req.user.id,
        approved: approvalFields.approved ?? false,
        approved_by: approvalFields.approved_by ?? null,
        approved_at: approvalFields.approved_at ?? null,
      }, { client });

      return audit;
    });

    const data = await findAudit({ audit_id: row.audit_id });
    await log(req, "create", row.audit_id, { start_date, end_date, assignments: hasAssignments ? assignments.length : 1 }, row);

    return res.status(201).json({ success: true, data, message: "Audit created successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateAuditController = async (req, res) => {
  try {
    const { id, start_date, end_date, remarks, assignments, approved, status } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findAudit({ audit_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    const hasAssignments = Array.isArray(assignments) && assignments.length > 0;
    if (hasAssignments) {
      const validation = validateAuditAssignments(assignments);
      if (!validation.ok) {
        return res.status(400).json({ success: false, message: validation.message });
      }
    }

    const fields = {
      ...(start_date !== undefined && { start_date }),
      ...(end_date !== undefined && { end_date }),
      ...(remarks !== undefined && { remarks }),
      ...(hasAssignments && { assignments }),
      updated_by: req.user.id,
      updated_at: new Date(),
    };

    // If audit was already verified, only super admin can edit
    if (existing.status === 'verified' && req.user.type !== 'super_admin') {
      return res.status(403).json({ success: false, message: "Verified audits cannot be edited" });
    }

    if (existing.approved === true) {
      return res.status(403).json({
        success: false,
        message: "Active audits cannot be edited. Delete and recreate if changes are needed.",
      });
    }

    if (normalizedApproved !== undefined) {
      applyApprovalWorkflow({
        req,
        fields,
        incomingApproved: normalizedApproved,
        hasBusinessChanges: false,
      });
    }

    if (fields.approved === true && existing.status === "approved") {
      fields.status = "pending";
    } else if (status !== undefined) {
      fields.status = status;
    }

    const updated = await updateAudit(fields, { audit_id: id });
    await log(req, "update", id, { updated_fields: fields });

    const data = await findAudit({ audit_id: id });
    return res.json({ success: true, data, message: "Audit updated successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteAuditController = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findAudit({ audit_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    if (existing.status === 'verified' && req.user.type !== 'super_admin') {
      return res.status(403).json({ success: false, message: "Verified audits cannot be deleted" });
    }

    await deleteAudit({ audit_id: id }, { deleted_by: req.user.id });
    await log(req, "delete", id, { remarks: existing.remarks, status: existing.status }, existing);

    return res.json({ success: true, message: "Audit deleted successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const submitAuditScan = async (req, res) => {
  try {
    const { audit_id, location_id, box_no_uids, complete_location = true } = req.body;
    const userId = req.user.id;

    if (!audit_id) return res.status(400).json({ success: false, message: "audit_id required" });
    if (!location_id) return res.status(400).json({ success: false, message: "location_id required" });
    if (!box_no_uids || !Array.isArray(box_no_uids)) return res.status(400).json({ success: false, message: "box_no_uids array required" });

    const audit = await findAudit({ audit_id });
    if (!audit) return res.status(404).json({ success: false, message: "Audit not found" });

    const locRow = (audit.locations || []).find(
      (loc) => Number(loc.location_id) === Number(location_id) && loc.is_active !== false
    );
    if (!locRow) {
      return res.status(404).json({ success: false, message: "Audit location not found" });
    }

    if (req.user.type !== "super_admin") {
      if (Number(locRow.assigned_user_id) !== Number(userId)) {
        return res.status(403).json({ success: false, message: "You are not assigned to this audit location" });
      }
    }

    if (!audit.approved && req.user.type !== "super_admin") {
      return res.status(403).json({ success: false, message: "Audit must be active before it can be started" });
    }

    if (!isWithinAuditDateRange(audit) && req.user.type !== "super_admin") {
      return res.status(403).json({ success: false, message: "Audit is outside of allowed date range" });
    }

    if ((audit.status === "submitted" || audit.status === "verified") && req.user.type !== "super_admin") {
      return res.status(403).json({ success: false, message: "Cannot modify a submitted or verified audit" });
    }

    if (req.user.type !== "super_admin" && isLocationClosed(locRow)) {
      return res.status(403).json({
        success: false,
        message: "This location is completed and cannot be edited",
      });
    }

    let progress;
    await withTransaction(async (client) => {
      if (box_no_uids.length > 0) {
        await appendAuditScannedBoxes({
          audit_id,
          location_id,
          box_no_uids,
          scanned_by: userId,
        }, { client });
      }

      if (complete_location || box_no_uids.length > 0) {
        progress = await evaluateAuditLocationProgress(audit_id, location_id, {
          forceComplete: Boolean(complete_location),
          client,
        });
      } else {
        const auditStatus = await syncAuditMasterStatus(audit_id, { client });
        progress = { location_status: locRow.status, audit_status: auditStatus, auto_completed: false };
      }
    });

    let message = "Scans saved successfully";
    if (progress?.auto_completed) {
      message = "All boxes matched — location completed automatically";
    } else if (progress?.location_status === "mismatch") {
      message = "Location saved — boxes missing, admin review required";
    } else if (progress?.location_status === "completed") {
      message = "Location complete";
    } else if (complete_location) {
      message = "Location marked as pending review";
    }

    if (progress?.audit_status === "verified") {
      message = "All locations matched — audit completed automatically";
    } else if (progress?.audit_status === "submitted") {
      message = "Audit submitted for admin review (mismatch detected)";
    }

    return res.json({
      success: true,
      message,
      data: progress,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const removeAuditScan = async (req, res) => {
  try {
    const { audit_id, location_id, box_no_uid } = req.body;
    const userId = req.user.id;

    if (!audit_id || !location_id || !box_no_uid) {
      return res.status(400).json({ success: false, message: "audit_id, location_id and box_no_uid required" });
    }

    const audit = await findAudit({ audit_id });
    if (!audit) return res.status(404).json({ success: false, message: "Audit not found" });

    const locRow = (audit.locations || []).find(
      (loc) => Number(loc.location_id) === Number(location_id) && loc.is_active !== false
    );
    if (!locRow) {
      return res.status(404).json({ success: false, message: "Audit location not found" });
    }

    if (req.user.type !== "super_admin") {
      if (Number(locRow.assigned_user_id) !== Number(userId)) {
        return res.status(403).json({ success: false, message: "You are not assigned to this audit location" });
      }
    }

    if (audit.status === 'submitted' || audit.status === 'verified') {
      return res.status(403).json({ success: false, message: "Cannot remove scans from a submitted audit" });
    }

    if (req.user.type !== "super_admin" && isLocationClosed(locRow)) {
      return res.status(403).json({
        success: false,
        message: "This location is completed and cannot be edited",
      });
    }

    await deleteAuditScan(audit_id, location_id, box_no_uid);

    return res.json({ success: true, message: "Scan removed successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const canViewAuditRecord = (req, audit) => canAccessAuditRecord(audit, req.user, req.permission);

function assertCanManageAudit(req, audit) {
  if (audit.status === "cancelled") {
    return { ok: false, status: 400, message: "Cancelled audit cannot be modified" };
  }
  if (audit.status === "verified" && req.user.type !== "super_admin") {
    return { ok: false, status: 403, message: "Only super admin can modify verified audits" };
  }
  const canManage =
    req.user.type === "super_admin" ||
    req.permission?.can_edit ||
    req.permission?.can_authorize ||
    Number(audit.created_by) === Number(req.user.id);
  if (!canManage) {
    return { ok: false, status: 403, message: "Access denied" };
  }
  return { ok: true };
}

export const reopenAuditLocationController = async (req, res) => {
  try {
    const { audit_id, location_id } = req.body;
    if (!audit_id || !location_id) {
      return res.status(400).json({ success: false, message: "audit_id and location_id required" });
    }

    const audit = await findAudit({ audit_id });
    if (!audit) return res.status(404).json({ success: false, message: "Audit not found" });

    const access = assertCanManageAudit(req, audit);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const locRow = (audit.locations || []).find(
      (loc) => Number(loc.location_id) === Number(location_id) && loc.is_active !== false
    );
    if (!locRow) {
      return res.status(404).json({ success: false, message: "Audit location not found" });
    }

    if (!isLocationClosed(locRow)) {
      return res.status(400).json({ success: false, message: "Location is not closed" });
    }

    const result = await withTransaction(async (client) =>
      reopenAuditLocation(audit_id, location_id, { client })
    );

    await log(req, "reopen_location", audit_id, { location_id, ...result });

    return res.json({
      success: true,
      message: "Location reopened — assigned user can continue audit",
      data: result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const reassignAuditLocationController = async (req, res) => {
  try {
    const { audit_id, location_id, assigned_user_id } = req.body;
    if (!audit_id || !location_id || !assigned_user_id) {
      return res.status(400).json({
        success: false,
        message: "audit_id, location_id and assigned_user_id required",
      });
    }

    const audit = await findAudit({ audit_id });
    if (!audit) return res.status(404).json({ success: false, message: "Audit not found" });

    const access = assertCanManageAudit(req, audit);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const locRow = (audit.locations || []).find(
      (loc) => Number(loc.location_id) === Number(location_id) && loc.is_active !== false
    );
    if (!locRow) {
      return res.status(404).json({ success: false, message: "Audit location not found" });
    }

    const result = await withTransaction(async (client) =>
      reassignAuditLocation(audit_id, location_id, assigned_user_id, { client })
    );

    await log(req, "reassign_location", audit_id, { location_id, ...result });

    const message = result.replaced
      ? "Location reassigned to the new user"
      : "Location reassigned — previous scans preserved in history";

    return res.json({
      success: true,
      message,
      data: result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Apply audit comparison adjustments to box_table, log box transactions, complete location(s). */
export const applyAuditComparisonAdjustmentController = async (req, res) => {
  try {
    const audit_id = Number(req.body?.audit_id ?? req.body?.id);
    const location_id = req.body?.location_id != null ? Number(req.body.location_id) : null;

    if (!Number.isFinite(audit_id)) {
      return res.status(400).json({ success: false, message: "audit_id required" });
    }

    const audit = await findAudit({ audit_id });
    if (!audit) return res.status(404).json({ success: false, message: "Not found" });

    const access = assertCanManageAudit(req, audit);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const result = await withTransaction(async (client) =>
      applyAuditComparisonAdjustment(audit_id, {
        locationId: location_id,
        userId: req.user.id,
        client,
        result_rejected: Boolean(req.body?.result_rejected ?? req.body?.rejected),
      })
    );

    await log(req, "comparison_adjustment", audit_id, { location_id, ...result }, audit);

    const message =
      result.audit_status === "verified"
        ? "Audit adjustment applied — audit completed"
        : "Audit adjustment applied — location closed as Complete";

    return res.json({ success: true, message, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Mark audit location Complete when scans match expected (no inventory adjustment). */
export const completeAuditLocationController = async (req, res) => {
  try {
    const audit_id = Number(req.body?.audit_id);
    const location_id = Number(req.body?.location_id);

    if (!Number.isFinite(audit_id) || !Number.isFinite(location_id)) {
      return res.status(400).json({ success: false, message: "audit_id and location_id required" });
    }

    const audit = await findAudit({ audit_id });
    if (!audit) return res.status(404).json({ success: false, message: "Not found" });

    const access = assertCanManageAudit(req, audit);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const result = await withTransaction(async (client) =>
      completeAuditLocation(audit_id, location_id, {
        client,
        result_rejected: Boolean(req.body?.result_rejected ?? req.body?.rejected),
      })
    );

    await log(req, "complete_location", audit_id, { location_id, ...result }, audit);

    const message = result.already_complete
      ? "Location is already Complete"
      : "Location marked Complete (no inventory adjustment)";

    return res.json({ success: true, message, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getAuditScoresController = async (req, res) => {
  try {
    const audit_id = Number(req.body?.audit_id ?? req.body?.id);
    if (!Number.isFinite(audit_id)) {
      return res.status(400).json({ success: false, message: "audit_id required" });
    }

    const audit = await findAudit({ audit_id });
    if (!audit) return res.status(404).json({ success: false, message: "Not found" });
    if (!canViewAuditRecord(req, audit)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const scores = await getAuditLocationScores(audit_id);
    return res.json({ success: true, data: scores });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getAuditComparisonReportController = async (req, res) => {
  try {
    const { id, location_id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const audit = await findAudit({ audit_id: id });
    if (!audit) return res.status(404).json({ success: false, message: "Not found" });

    if (!canViewAuditRecord(req, audit)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    if (location_id != null) {
      const locRow = (audit.locations || []).find(
        (loc) => Number(loc.location_id) === Number(location_id) && loc.is_active !== false
      );
      if (!locRow) {
        return res.status(404).json({ success: false, message: "Audit location not found" });
      }
      if (!isLocationClosed(locRow.status)) {
        return res.status(400).json({
          success: false,
          message: "Comparison is available only after the location is submitted",
        });
      }

      const data = await getAuditComparisonReport(id, { locationId: location_id });
      return res.json({ success: true, data });
    }

    if (!["submitted", "verified"].includes(audit.status)) {
      return res.status(400).json({
        success: false,
        message: "Comparison report is available only after the audit is submitted",
      });
    }

    const data = await getAuditComparisonReport(id);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const verifyAudit = async (req, res) => {
  try {
    const { id } = req.body;
    const userId = req.user.id;

    if (req.user.type !== 'super_admin') {
      return res.status(403).json({ success: false, message: "Only super admin can verify audits" });
    }

    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const audit = await findAudit({ audit_id: id });
    if (!audit) return res.status(404).json({ success: false, message: "Audit not found" });

    if (audit.status !== 'submitted') {
      return res.status(400).json({ success: false, message: "Only submitted audits can be verified" });
    }

    await updateAudit({
      status: 'verified',
      updated_by: userId,
      updated_at: new Date()
    }, { audit_id: id });

    await log(req, "verify", id, { status: 'verified' });

    return res.json({ success: true, message: "Audit verified successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
