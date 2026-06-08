import { findAudits, findAudit, insertAudit, updateAudit, deleteAudit, insertAuditScan, updateAuditLocationStatus, deleteAuditScan, countIncompleteAuditLocations, getAuditComparisonReport } from "../models/audit.model.js";
import { logActivity } from "../utils/activityLogger.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../utils/approval.js";
import { withTransaction } from "../../../config/db.js";

const CFG = getCrudModuleConfig("audit");

const log = (req, action, entity_id, details, record = null) =>
  logActivity(req, {
    action,
    entity: "audit",
    entity_id,
    details,
    record,
  }).catch(() => {});

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

    return res.json({ success: true, ...result });
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

    // Visibility check
    const user = req.user;
    const isSuperAdmin = user.type === 'super_admin';
    const canAuthorize = Boolean(req.permission?.can_authorize);
    const isCreator = data.created_by === user.id;
    const isAssigned = data.assigned_user_id === user.id;

    if (!isSuperAdmin && !canAuthorize && !isCreator) {
      if (isAssigned && !data.approved) {
        return res.status(403).json({ success: false, message: "Audit is not yet approved" });
      }
      if (!isAssigned && !data.approved) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    }

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createAudit = async (req, res) => {
  try {
    const { assigned_user_id, start_date, end_date, remarks, location_ids } = req.body;

    if (!assigned_user_id) return res.status(400).json({ success: false, message: "assigned_user_id required" });
    if (!start_date) return res.status(400).json({ success: false, message: "start_date required" });
    if (!end_date) return res.status(400).json({ success: false, message: "end_date required" });
    if (!location_ids || !location_ids.length) return res.status(400).json({ success: false, message: "At least one location required" });

    const row = await withTransaction(async (client) => {
      const audit = await insertAudit({
        assigned_user_id,
        start_date,
        end_date,
        remarks,
        location_ids,
        created_by: req.user.id
      }, { client });

      return audit;
    });

    const data = await findAudit({ audit_id: row.audit_id });
    await log(req, "create", row.audit_id, { assigned_user_id, start_date, end_date }, row);

    return res.status(201).json({ success: true, data, message: "Audit created successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateAuditController = async (req, res) => {
  try {
    const { id, assigned_user_id, start_date, end_date, remarks, location_ids, approved, status } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findAudit({ audit_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    const hasBusinessChanges = assigned_user_id !== undefined || start_date !== undefined || end_date !== undefined || remarks !== undefined || location_ids !== undefined;

    const fields = {
      ...(assigned_user_id !== undefined && { assigned_user_id }),
      ...(start_date !== undefined && { start_date }),
      ...(end_date !== undefined && { end_date }),
      ...(remarks !== undefined && { remarks }),
      ...(location_ids !== undefined && { location_ids }),
      updated_by: req.user.id,
      updated_at: new Date(),
    };

    // If audit was already verified, only super admin can edit
    if (existing.status === 'verified' && req.user.type !== 'super_admin') {
      return res.status(403).json({ success: false, message: "Verified audits cannot be edited" });
    }

    applyApprovalWorkflow({ req, fields, incomingApproved: normalizedApproved, hasBusinessChanges });

    // Manager authorization is separate from audit execution status.
    if (fields.approved === true) {
      if (existing.status === "approved") {
        fields.status = "pending";
      }
    } else if (normalizedApproved === false || (hasBusinessChanges && existing.approved)) {
      fields.approved = false;
      if (["pending", "approved"].includes(existing.status)) {
        fields.status = "pending";
      }
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

    if (audit.assigned_user_id !== userId && req.user.type !== 'super_admin') {
      return res.status(403).json({ success: false, message: "You are not assigned to this audit" });
    }

    if (!audit.approved && req.user.type !== 'super_admin') {
      return res.status(403).json({ success: false, message: "Audit must be approved before it can be started" });
    }

    const now = new Date();
    const startDate = new Date(audit.start_date);
    const endDate = new Date(audit.end_date);
    endDate.setHours(23, 59, 59, 999);

    if (now < startDate || now > endDate) {
      return res.status(403).json({ success: false, message: "Audit is outside of allowed date range" });
    }

    if ((audit.status === 'submitted' || audit.status === 'verified') && req.user.type !== 'super_admin') {
      return res.status(403).json({ success: false, message: "Cannot modify a submitted or verified audit" });
    }

    await withTransaction(async (client) => {
      if (box_no_uids.length > 0) {
        for (const box_no_uid of box_no_uids) {
          await insertAuditScan({
            audit_id,
            location_id,
            box_no_uid,
            scanned_by: userId
          }, { client });
        }
      }

      if (complete_location) {
        await updateAuditLocationStatus(audit_id, location_id, 'completed', { client });
      } else {
        await updateAuditLocationStatus(audit_id, location_id, 'pending', { client });
      }

      const incompleteCount = await countIncompleteAuditLocations(audit_id, { client });
      if (incompleteCount === 0) {
        await updateAudit({ status: 'submitted' }, { audit_id }, { client });
      } else {
        await updateAudit({ status: 'in_progress' }, { audit_id }, { client });
      }
    });

    return res.json({ success: true, message: complete_location ? "Location completed successfully" : "Scans saved successfully" });
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

    if (audit.assigned_user_id !== userId && req.user.type !== 'super_admin') {
      return res.status(403).json({ success: false, message: "You are not assigned to this audit" });
    }

    if (audit.status === 'submitted' || audit.status === 'verified') {
      return res.status(403).json({ success: false, message: "Cannot remove scans from a submitted audit" });
    }

    await deleteAuditScan(audit_id, location_id, box_no_uid);

    return res.json({ success: true, message: "Scan removed successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const canViewAuditRecord = (req, audit) => {
  const user = req.user;
  const isSuperAdmin = user.type === "super_admin";
  const canAuthorize = Boolean(req.permission?.can_authorize);
  const isCreator = audit.created_by === user.id;
  const isAssigned = audit.assigned_user_id === user.id;

  if (isSuperAdmin || canAuthorize || isCreator) return true;
  if (isAssigned && audit.approved) return true;
  return false;
};

export const getAuditComparisonReportController = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const audit = await findAudit({ audit_id: id });
    if (!audit) return res.status(404).json({ success: false, message: "Not found" });

    if (!canViewAuditRecord(req, audit)) {
      return res.status(403).json({ success: false, message: "Access denied" });
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
