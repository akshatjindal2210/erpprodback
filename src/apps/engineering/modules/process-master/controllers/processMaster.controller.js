import { findProcesses, findProcess, findStageConflict, insertProcess, updateProcesses, deleteProcesses, countActiveChildren, PROCESS_DEFAULT_FIELDS } from "../models/processMaster.model.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput, applyApprovalUpdateFields, prepareUpdateByRules } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import logger from "../../../../core/lib/utils/logging/logger.js";

const CFG = getCrudModuleConfig("eng_process_master");
const ENTITY = "eng_process_master";
const TYPES = new Set(["MASTER", "SUB", "SUB_SUB"]);
const STAGES = new Set(["START", "MID", "END"]);

const log = (req, action, entity_id, details, record = null, existing = null) =>
  logActivity(req, { action, entity: ENTITY, entity_id, details, record, existing }).catch(() => {});

function normalizeType(v) {
  return String(v ?? "").trim().toUpperCase();
}

function normalizeStage(v) {
  const s = String(v ?? "MID").trim().toUpperCase();
  return STAGES.has(s) ? s : "MID";
}

function validateRegexPattern(pattern) {
  if (pattern == null || String(pattern).trim() === "") return null;
  const text = String(pattern).trim();
  try {
    // eslint-disable-next-line no-new
    new RegExp(text);
    return text;
  } catch {
    const err = new Error("Invalid pattern — must be a valid regular expression");
    err.statusCode = 400;
    throw err;
  }
}

async function assertParentForType(type, parent_id) {
  if (type === "MASTER") {
    if (parent_id) {
      const err = new Error("MASTER process cannot have a parent");
      err.statusCode = 400;
      throw err;
    }
    return null;
  }
  if (!parent_id) {
    const err = new Error(`${type} process requires a parent`);
    err.statusCode = 400;
    throw err;
  }
  const parent = await findProcess({ id: parent_id });
  if (!parent) {
    const err = new Error("Parent process not found");
    err.statusCode = 400;
    throw err;
  }
  if (type === "SUB" && parent.type !== "MASTER") {
    const err = new Error("SUB parent must be a MASTER process");
    err.statusCode = 400;
    throw err;
  }
  if (type === "SUB_SUB" && parent.type !== "SUB") {
    const err = new Error("SUB_SUB parent must be a SUB process");
    err.statusCode = 400;
    throw err;
  }
  return parent;
}

async function assertUniqueStage(stage, excludeId = null) {
  const conflict = await findStageConflict({ stage, excludeId });
  if (conflict) {
    const err = new Error(
      `Only one active ${stage} process is allowed. Existing: "${conflict.name}" (id ${conflict.id})`
    );
    err.statusCode = 409;
    throw err;
  }
}

export const listProcesses = async (req, res) => {
  try {
    const { page, limit, sortBy, order, search, filters } = extractListParams(req.body || {});
    const safeFilters = sanitizeFilters(filters, CFG?.filterFields || []);
    const result = await findProcesses({
      filters: safeFilters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: CFG?.listFields?.length ? CFG.listFields : PROCESS_DEFAULT_FIELDS,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`[eng_process_master] list error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getProcess = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });
    const data = await findProcess({ id });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, data });
  } catch (err) {
    logger.error(`[eng_process_master] get error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createProcess = async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const type = normalizeType(req.body?.type);
    const stage = normalizeStage(req.body?.stage);
    const parent_id = req.body?.parent_id ? parsePositiveIntId(req.body.parent_id) : null;
    const multi_mc = !!req.body?.multi_mc;
    const pattern = validateRegexPattern(req.body?.pattern);
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);

    if (!name) return res.status(400).json({ success: false, message: "name required" });
    if (!TYPES.has(type)) return res.status(400).json({ success: false, message: "type must be MASTER, SUB or SUB_SUB" });

    await assertParentForType(type, parent_id);
    await assertUniqueStage(stage);

    const row = await insertProcess({
      name,
      type,
      parent_id: type === "MASTER" ? null : parent_id,
      stage,
      multi_mc,
      pattern,
      created_by: auditUserName(req),
    });

    if (normalizedApproved === true) {
      const approvalFields = {
        updated_by: auditUserName(req),
        updated_at: new Date(),
      };
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: true,
        hasBusinessChanges: false,
        auditAsName: true,
        approvalTimestamp: row?.created_at || new Date(),
      });
      await updateProcesses(approvalFields, { id: row.id });
    }

    const data = await findProcess({ id: row.id });
    logger.info(`[eng_process_master] create user=${req?.user?.id} id=${row.id} name=${name}`);
    await log(req, "create", row.id, { name, type, stage, parent_id }, data);

    return res.status(201).json({ success: true, data, message: "Process created successfully" });
  } catch (err) {
    logger.error(`[eng_process_master] create error user=${req?.user?.id}: ${err?.message || err}`);
    if (err?.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Only one active START and one active END process is allowed",
      });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const updateProcess = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);
    if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });

    const existing = await findProcess({ id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    if (req.user.type !== "super_admin" && req.permission && req.permission.can_edit_days > 0) {
      const createdAt = new Date(existing.created_at);
      const diffDays = Math.ceil(Math.abs(Date.now() - createdAt) / (1000 * 60 * 60 * 24));
      if (diffDays > req.permission.can_edit_days) {
        return res.status(403).json({
          success: false,
          message: `Edit time limit exceeded. You can only edit records from the last ${req.permission.can_edit_days} days.`,
        });
      }
    }

    const input = {
      name: req.body?.name,
      type: req.body?.type !== undefined ? normalizeType(req.body.type) : undefined,
      parent_id: req.body?.parent_id !== undefined
        ? (req.body.parent_id ? parsePositiveIntId(req.body.parent_id) : null)
        : undefined,
      stage: req.body?.stage !== undefined ? normalizeStage(req.body.stage) : undefined,
      multi_mc: req.body?.multi_mc,
      pattern: req.body?.pattern !== undefined ? validateRegexPattern(req.body.pattern) : undefined,
    };

    const { hasChanges: hasBusinessChanges, fields: preparedFields } = prepareUpdateByRules({
      existing,
      input,
      rules: [
        { field: "name", normalize: (v) => String(v ?? "").trim() },
        { field: "type", normalize: normalizeType },
        { field: "parent_id", normalize: (v) => (v == null || v === "" ? null : Number(v)) },
        { field: "stage", normalize: normalizeStage },
        { field: "multi_mc", normalize: (v) => !!v },
        { field: "pattern", normalize: (v) => (v == null || v === "" ? null : String(v).trim()) },
      ],
    });

    if (!hasBusinessChanges && normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    const fields = { ...preparedFields };
    const finalType = fields.type ?? existing.type;
    const finalParent = fields.parent_id !== undefined ? fields.parent_id : existing.parent_id;
    const finalStage = fields.stage ?? existing.stage;

    if (fields.name !== undefined && !fields.name) {
      return res.status(400).json({ success: false, message: "name required" });
    }
    if (fields.type !== undefined && !TYPES.has(fields.type)) {
      return res.status(400).json({ success: false, message: "type must be MASTER, SUB or SUB_SUB" });
    }

    await assertParentForType(finalType, finalType === "MASTER" ? null : finalParent);
    if (finalType === "MASTER") fields.parent_id = null;
    if (finalStage !== existing.stage) await assertUniqueStage(finalStage, id);

    applyApprovalUpdateFields({
      req,
      fields,
      incomingApproved: normalizedApproved,
      hasBusinessChanges,
      alreadyApproved: existing.approved === true,
      auditAsName: true,
    });

    await updateProcesses(fields, { id });
    const data = await findProcess({ id });

    logger.info(`[eng_process_master] update user=${req?.user?.id} id=${id} approved=${normalizedApproved}`);
    await log(req, "update", id, { updated_fields: fields }, data, existing);

    return res.json({ success: true, data, message: "Process updated successfully" });
  } catch (err) {
    logger.error(`[eng_process_master] update error user=${req?.user?.id}: ${err?.message || err}`);
    if (err?.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Only one active START and one active END process is allowed",
      });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteProcess = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });

    const existing = await findProcess({ id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    const childCount = await countActiveChildren(id);
    if (childCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete — ${childCount} child process(es) still active`,
      });
    }

    await deleteProcesses({ id }, { deleted_by: auditUserName(req) });
    logger.info(`[eng_process_master] delete user=${req?.user?.id} id=${id}`);
    await log(req, "delete", id, { name: existing.name }, existing);

    return res.json({ success: true, message: "Process deleted successfully" });
  } catch (err) {
    logger.error(`[eng_process_master] delete error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const listProcessViews = async (req, res) => {
  try {
    const body = req.body || {};
    const { page, limit, search, filters } = extractListParams(body);
    const safeFilters = sanitizeFilters(filters || {}, ["id", "type", "approved", "parent_id", "stage"]);

    // Single-row resolve for SearchableSelect getById (via helper, no eng_process_master.view needed)
    const byId = parsePositiveIntId(body.id ?? safeFilters.id);
    if (byId) {
      const row = await findProcess({ id: byId });
      if (!row) {
        return res.json({ success: true, data: [], total: 0 });
      }
      const item = {
        id: row.id,
        name: row.name,
        label: row.path_label || row.name,
        type: row.type,
        stage: row.stage,
        parent_id: row.parent_id,
      };
      return res.json({ success: true, data: [item], total: 1 });
    }

    const views = await findProcesses({
      filters: { approved: true, ...safeFilters },
      search: sanitizeSearch(search),
      sort: { by: "name", order: "ASC" },
      page: page || 1,
      limit: limit || 50,
    });
    const data = (views.data || []).map((r) => ({
      id: r.id,
      name: r.name,
      label: r.path_label || r.name,
      type: r.type,
      stage: r.stage,
      parent_id: r.parent_id,
    }));
    return res.json({ success: true, data, total: views.total });
  } catch (err) {
    logger.error(`[eng_process_master] helper error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};
