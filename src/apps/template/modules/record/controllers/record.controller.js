import { findRecords, findRecord, findRecordDuplicate, insertRecord, updateRecords, deleteRecords } from "../models/record.model.js";

import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { applyApprovalWorkflow, normalizeApprovedInput, auditUserName, applyApprovalUpdateFields, prepareUpdateByRules } from "../../../../core/lib/utils/auth/approval.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";

const MODULE = "template_record";
const CFG = getCrudModuleConfig(MODULE) || { filterFields: [] };

function trimName(value) {
  return String(value ?? "").trim();
}

function prepareRecordUpdate(existing, next = {}) {
  return prepareUpdateByRules({
    existing,
    input: next,
    rules: [
      { field: "name", normalize: (v) => trimName(v) },
      { field: "notes", normalize: (v) => (v == null ? null : String(v)) },
    ],
  });
}

function assertEditWindow(req, existing) {
  const editDaysLimit = Number(req.permission?.can_edit_days) || 0;
  if (req.user.type === "super_admin" || !req.permission?.can_edit || editDaysLimit <= 0) return;
  const createdAt = new Date(existing.created_at);
  const diffDays = Math.ceil(Math.abs(Date.now() - createdAt) / (1000 * 60 * 60 * 24));
  if (diffDays > editDaysLimit) {
    const err = new Error(`Edit time limit exceeded. You can only edit records from the last ${editDaysLimit} days.`);
    err.statusCode = 403;
    throw err;
  }
}

export const listRecords = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "record_id",
      order: "DESC",
    });
    const result = await findRecords({
      filters: sanitizeFilters(filters, CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getRecord = async (req, res) => {
  try {
    const { record_id } = req.body;
    if (!record_id) return res.status(400).json({ success: false, message: "ID required" });
    const data = await findRecord({ record_id });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createRecord = async (req, res) => {
  try {
    const name = trimName(req.body.name);
    const notes = req.body.notes == null ? null : String(req.body.notes);
    const normalizedApproved = normalizeApprovedInput(req.body.approved);

    if (!name) return res.status(400).json({ success: false, message: "Name is required" });
    if (name.length > 120) return res.status(400).json({ success: false, message: "Name must be 120 characters or less" });

    if (await findRecordDuplicate({ name })) {
      return res.status(409).json({ success: false, message: "A record with this name already exists" });
    }

    const row = await insertRecord({ name, notes, created_by: auditUserName(req) });

    if (normalizedApproved === true) {
      const approvalFields = {};
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: true,
        hasBusinessChanges: false,
        auditAsName: true,
        approvalTimestamp: row?.created_at || new Date(),
      });
      await updateRecords(approvalFields, { record_id: row.record_id });
    }

    const data = await findRecord({ record_id: row.record_id });
    await logActivity(req, { action: "create", entity: MODULE, entity_id: row.record_id, record: row });
    res.status(201).json({ success: true, data });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message });
  }
};

export const updateRecord = async (req, res) => {
  try {
    const { record_id } = req.body;
    const normalizedApproved = normalizeApprovedInput(req.body.approved);
    if (!record_id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findRecord({ record_id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    assertEditWindow(req, existing);

    const name = req.body.name === undefined ? undefined : trimName(req.body.name);
    if (name !== undefined && !name) return res.status(400).json({ success: false, message: "Name is required" });

    const { hasChanges, fields } = prepareRecordUpdate(existing, { name, notes: req.body.notes });
    if (!hasChanges && normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    if (hasChanges && name) {
      const duplicate = await findRecordDuplicate({ name, excludeId: record_id });
      if (duplicate) return res.status(409).json({ success: false, message: "A record with this name already exists" });
    }

    applyApprovalUpdateFields({
      req,
      fields,
      incomingApproved: normalizedApproved,
      hasBusinessChanges: hasChanges,
      alreadyApproved: existing.approved === true,
      auditAsName: true,
    });

    await updateRecords(fields, { record_id });
    const data = await findRecord({ record_id });
    await logActivity(req, { action: "update", entity: MODULE, entity_id: record_id, details: { updated_fields: fields } });
    res.json({ success: true, message: "Record updated", data });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message });
  }
};

export const deleteRecord = async (req, res) => {
  try {
    const { record_id } = req.body;
    if (!record_id) return res.status(400).json({ success: false, message: "ID required" });
    const existing = await findRecord({ record_id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    await deleteRecords({ record_id }, { deleted_by: auditUserName(req) });
    await logActivity(req, { action: "delete", entity: MODULE, entity_id: record_id, record: existing });
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const helperRecords = async (req, res) => {
  try {
    const { id, search } = req.body || {};
    if (id) {
      const data = await findRecord({ record_id: id });
      if (!data || !data.approved) return res.json({ success: true, data: null });
      return res.json({ success: true, data: { record_id: data.record_id, name: data.name } });
    }

    const result = await findRecords({
      filters: { approved: true },
      search: sanitizeSearch(search),
      sort: { by: "name", order: "ASC" },
      page: 1,
      limit: 5000,
    });
    res.json({
      success: true,
      data: (result.data || []).map((row) => ({ record_id: row.record_id, name: row.name })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
