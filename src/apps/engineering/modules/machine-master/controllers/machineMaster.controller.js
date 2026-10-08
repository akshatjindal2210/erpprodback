import { findMachines, findMachine, findMachineByNumber, insertMachine, updateMachines, deleteMachines, MACHINE_DEFAULT_FIELDS } from "../models/machineMaster.model.js";
import { findProcess } from "../../process-master/models/processMaster.model.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput, applyApprovalUpdateFields, prepareUpdateByRules } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { toEngMachinePublicUploadPath } from "../../../../ims/lib/middleware/upload.js";
import logger from "../../../../core/lib/utils/logging/logger.js";

const CFG = getCrudModuleConfig("eng_machine_master");
const ENTITY = "eng_machine_master";

const log = (req, action, entity_id, details, record = null, existing = null) => logActivity(req, { action, entity: ENTITY, entity_id, details, record, existing }).catch(() => {});

/** FE sends duration_value + duration_unit; API may send `duration` as seconds. */
function parseDuration(body) {
  const hasUnitInput = body?.duration_value !== undefined || body?.duration_unit !== undefined;
  if (!hasUnitInput && body?.duration !== undefined && body?.duration !== null && body?.duration !== "") {
    const n = Number(body.duration);
    if (!Number.isFinite(n) || n < 0) {
      const err = new Error("duration must be a non-negative number");
      err.statusCode = 400;
      throw err;
    }
    return Math.round(n);
  }
  const value = Number(body?.duration_value ?? 60);
  const unit = String(body?.duration_unit || "sec").trim().toLowerCase();
  if (!Number.isFinite(value) || value < 0) {
    const err = new Error("duration must be a non-negative number");
    err.statusCode = 400;
    throw err;
  }
  if (unit === "min" || unit === "mins" || unit === "minute" || unit === "minutes") {
    return Math.round(value * 60);
  }
  if (unit === "hour" || unit === "hours" || unit === "hr" || unit === "hrs") {
    return Math.round(value * 3600);
  }
  return Math.round(value);
}

function normalizeAttachments(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseRemoveAttachmentIds(body) {
  const raw = body?.remove_attachment_ids ?? body?.delete_attachment_ids ?? [];
  let arr = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      arr = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map((v) => String(v)).filter(Boolean);
}

function mapUploadedFiles(req) {
  const files = Array.isArray(req.files) ? req.files : [];
  return files
    .map((file, idx) => {
      const path = toEngMachinePublicUploadPath(file);
      if (!path) return null;
      return {
        id: `${Date.now().toString(36)}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
        file_name: file.originalname || file.filename,
        path,
        size: file.size ?? null,
      };
    })
    .filter(Boolean);
}

/** Store speed exactly as typed (no 10 → 10.0000). */
function normalizeSpeed(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim();
  return s || null;
}

function mergeAttachments(existing = [], uploaded = [], removeIds = []) {
  const removeSet = new Set(removeIds.map(String));
  const kept = normalizeAttachments(existing).filter((a) => a && !removeSet.has(String(a.id)));
  return [...kept, ...uploaded];
}

async function assertApprovedProcess(process_id) {
  const process = await findProcess({ id: process_id });
  if (!process) {
    const err = new Error("Process not found");
    err.statusCode = 400;
    throw err;
  }
  if (!process.approved) {
    const err = new Error("Process must be approved before linking to a machine");
    err.statusCode = 400;
    throw err;
  }
  return process;
}

function normalizeApprovedBody(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export const listMachines = async (req, res) => {
  try {
    const { page, limit, sortBy, order, search, filters } = extractListParams(req.body || {});
    const safeFilters = sanitizeFilters(filters, CFG?.filterFields || []);
    const result = await findMachines({
      filters: safeFilters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: CFG?.listFields?.length ? CFG.listFields : MACHINE_DEFAULT_FIELDS,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`[eng_machine_master] list error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getMachine = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });
    const data = await findMachine({ id });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, data: { ...data, attachments: normalizeAttachments(data.attachments) } });
  } catch (err) {
    logger.error(`[eng_machine_master] get error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createMachine = async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const number = String(req.body?.number ?? "").trim();
    const process_id = parsePositiveIntId(req.body?.process_id);
    const speed = normalizeSpeed(req.body?.speed);
    const duration = parseDuration(req.body);
    const make = req.body?.make != null ? String(req.body.make).trim() : null;
    const model = req.body?.model != null ? String(req.body.model).trim() : null;
    const remark = req.body?.remark != null ? String(req.body.remark).trim() : null;
    const normalizedApproved = normalizeApprovedInput(normalizeApprovedBody(req.body?.approved));
    const attachments = mapUploadedFiles(req);

    if (!name) return res.status(400).json({ success: false, message: "name required" });
    if (!number) return res.status(400).json({ success: false, message: "number required" });
    if (!process_id) return res.status(400).json({ success: false, message: "process required" });

    await assertApprovedProcess(process_id);
    const dup = await findMachineByNumber({ number });
    if (dup) {
      return res.status(409).json({ success: false, message: `Machine number "${number}" already exists` });
    }

    const row = await insertMachine({
      name,
      number,
      process_id,
      speed,
      duration,
      make: make || null,
      model: model || null,
      remark: remark || null,
      attachments,
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
      await updateMachines(approvalFields, { id: row.id });
    }

    const data = await findMachine({ id: row.id });
    logger.info(`[eng_machine_master] create user=${req?.user?.id} id=${row.id} number=${number}`);
    await log(req, "create", row.id, { name, number, process_id, attachments: attachments.length }, data);

    return res.status(201).json({
      success: true,
      data: { ...data, attachments: normalizeAttachments(data?.attachments) },
      message: "Machine created successfully",
    });
  } catch (err) {
    logger.error(`[eng_machine_master] create error user=${req?.user?.id}: ${err?.message || err}`);
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: "Machine number already exists" });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const updateMachine = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    const normalizedApproved = normalizeApprovedInput(normalizeApprovedBody(req.body?.approved));
    if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });

    const existing = await findMachine({ id });
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

    const hasDurationInput =
      req.body?.duration_value !== undefined ||
      req.body?.duration !== undefined ||
      req.body?.duration_unit !== undefined;

    const input = {
      name: req.body?.name,
      number: req.body?.number,
      process_id: req.body?.process_id !== undefined ? parsePositiveIntId(req.body.process_id) : undefined,
      speed: req.body?.speed !== undefined ? normalizeSpeed(req.body.speed) : undefined,
      duration: hasDurationInput ? parseDuration(req.body) : undefined,
      make: req.body?.make,
      model: req.body?.model,
      remark: req.body?.remark,
    };

    const { hasChanges: fieldChanges, fields: preparedFields } = prepareUpdateByRules({
      existing,
      input,
      rules: [
        { field: "name", normalize: (v) => String(v ?? "").trim() },
        { field: "number", normalize: (v) => String(v ?? "").trim() },
        { field: "process_id", normalize: (v) => Number(v) },
        { field: "speed", normalize: (v) => normalizeSpeed(v) },
        { field: "duration", normalize: (v) => Math.round(Number(v)) },
        { field: "make", normalize: (v) => (v == null || v === "" ? null : String(v).trim()) },
        { field: "model", normalize: (v) => (v == null || v === "" ? null : String(v).trim()) },
        { field: "remark", normalize: (v) => (v == null || v === "" ? null : String(v).trim()) },
      ],
    });

    const removeIds = parseRemoveAttachmentIds(req.body);
    const uploaded = mapUploadedFiles(req);
    const nextAttachments = mergeAttachments(existing.attachments, uploaded, removeIds);
    const hasAttachmentChanges = removeIds.length > 0 || uploaded.length > 0;
    const hasBusinessChanges = fieldChanges || hasAttachmentChanges;

    if (!hasBusinessChanges && normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    const fields = { ...preparedFields };
    if (hasAttachmentChanges) fields.attachments = nextAttachments;

    if (fields.name !== undefined && !fields.name) {
      return res.status(400).json({ success: false, message: "name required" });
    }
    if (fields.number !== undefined && !fields.number) {
      return res.status(400).json({ success: false, message: "number required" });
    }
    if (fields.process_id !== undefined) {
      await assertApprovedProcess(fields.process_id);
    }
    if (fields.number !== undefined) {
      const dup = await findMachineByNumber({ number: fields.number, excludeId: id });
      if (dup) {
        return res.status(409).json({ success: false, message: `Machine number "${fields.number}" already exists` });
      }
    }

    applyApprovalUpdateFields({
      req,
      fields,
      incomingApproved: normalizedApproved,
      hasBusinessChanges,
      alreadyApproved: existing.approved === true,
      auditAsName: true,
    });

    if (Object.keys(fields).length) {
      await updateMachines(fields, { id });
    }

    const data = await findMachine({ id });
    logger.info(`[eng_machine_master] update user=${req?.user?.id} id=${id} approved=${normalizedApproved}`);
    await log(req, "update", id, { updated_fields: fields, removeIds, uploaded: uploaded.length }, data, existing);

    return res.json({
      success: true,
      data: { ...data, attachments: normalizeAttachments(data?.attachments) },
      message: "Machine updated successfully",
    });
  } catch (err) {
    logger.error(`[eng_machine_master] update error user=${req?.user?.id}: ${err?.message || err}`);
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: "Machine number already exists" });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteMachine = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });

    const existing = await findMachine({ id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    await deleteMachines({ id }, { deleted_by: auditUserName(req) });
    logger.info(`[eng_machine_master] delete user=${req?.user?.id} id=${id}`);
    await log(req, "delete", id, { number: existing.number }, existing);

    return res.json({ success: true, message: "Machine deleted successfully" });
  } catch (err) {
    logger.error(`[eng_machine_master] delete error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};
