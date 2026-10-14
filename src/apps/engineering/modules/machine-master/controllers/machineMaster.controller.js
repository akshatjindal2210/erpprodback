import { findMachines, findMachine, findMachineDuplicate, insertMachine, updateMachines, deleteMachines, MACHINE_DEFAULT_FIELDS } from "../models/machineMaster.model.js";
import { findProcess } from "../../process-master/models/processMaster.model.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput, applyApprovalUpdateFields, prepareUpdateByRules } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { toEngMachinePublicUploadPath } from "../../../../ims/lib/middleware/upload.js";
import { mapMulterFilesWithRemarks, syncAttachmentList } from "../../../../../lib/documents/index.js";
import { stampRmstoreUploadedFiles } from "../../../../rmstore/lib/utils/stampRmstoreUploadedFiles.js";
import { resolveMachineQrPayload } from "../../../../core/lib/utils/qr/publicQrUrl.js";
import logger from "../../../../core/lib/utils/logging/logger.js";

const MODULE = "eng_machine_master";
const CFG = getCrudModuleConfig(MODULE);
const ENTITY = MODULE;

const log = (req, action, entity_id, details, record = null, existing = null) => logActivity(req, { action, entity: ENTITY, entity_id, details, record, existing }).catch(() => {});

/** Time fields stored in seconds. FE sends `<field>_value` + `<field>_unit` (sec / min / hour); API may send `<field>` in seconds. */
const TIME_FIELDS = { duration: 60, setup_time: 0 }; // field → default seconds
const UNIT_SECONDS = { sec: 1, min: 60, hour: 3600 };
const UNIT_ALIAS = { mins: "min", minute: "min", minutes: "min", hours: "hour", hr: "hour", hrs: "hour" };

const hasTimeInput = (body, field) =>
  body?.[`${field}_value`] !== undefined || body?.[`${field}_unit`] !== undefined || body?.[field] !== undefined;

function parseSeconds(body, field) {
  const hasUnitInput = body?.[`${field}_value`] !== undefined || body?.[`${field}_unit`] !== undefined;
  const raw = hasUnitInput ? body?.[`${field}_value`] : body?.[field];
  const value = raw === undefined || raw === null || raw === "" ? TIME_FIELDS[field] : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw Object.assign(new Error(`${field} must be a non-negative number`), { statusCode: 400 });
  }
  const unit = String(hasUnitInput ? body?.[`${field}_unit`] || "sec" : "sec").trim().toLowerCase();
  return Math.round(value * (UNIT_SECONDS[UNIT_ALIAS[unit] ?? unit] ?? 1));
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
  return mapMulterFilesWithRemarks(req, (f) => toEngMachinePublicUploadPath(f)).map((u) => ({
    file_name: u.file.originalname || u.file.filename,
    path: u.docPath,
    size: u.file.size ?? null,
  }));
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

/** 409 message when another active machine already has this name or number, else null. */
async function duplicateMessage(fields, excludeId = null) {
  for (const field of ["name", "number"]) {
    if (fields[field] !== undefined && (await findMachineDuplicate(field, fields[field], excludeId))) {
      return `Machine ${field} "${fields[field]}" already exists`;
    }
  }
  return null;
}

async function assertApprovedProcess(process_id) {
  const process = await findProcess(process_id);
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

/** Machine dropdown (helper) — approved machines, optional `filters.process_id`; `id` resolves one row. */
export const listMachineViews = async (req, res) => {
  try {
    const body = req.body || {};
    const toView = (r) => ({ id: r.id, name: r.name, number: r.number, process_id: r.process_id, label: `${r.number} — ${r.name}` });

    const byId = parsePositiveIntId(body.id);
    if (byId) {
      const row = await findMachine({ id: byId });
      return res.json({ success: true, data: row ? [toView(row)] : [], total: row ? 1 : 0 });
    }

    const { page, limit, search, filters } = extractListParams(body);
    const safeFilters = sanitizeFilters(filters || {}, ["process_id"]);
    const result = await findMachines({
      filters: { ...safeFilters, approved: true },
      search: sanitizeSearch(search),
      sort: { by: "id", order: "ASC" },
      page: page || 1,
      limit: limit || 50,
    });
    return res.json({ success: true, data: (result.data || []).map(toView), total: result.total });
  } catch (err) {
    logger.error(`[eng_machine_master] helper error user=${req?.user?.id}: ${err?.message || err}`);
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
    const duration = parseSeconds(req.body, "duration");
    const setup_time = parseSeconds(req.body, "setup_time");
    const make = req.body?.make != null ? String(req.body.make).trim() : null;
    const model = req.body?.model != null ? String(req.body.model).trim() : null;
    const remark = req.body?.remark != null ? String(req.body.remark).trim() : null;
    const normalizedApproved = normalizeApprovedInput(normalizeApprovedBody(req.body?.approved));
    await stampRmstoreUploadedFiles(req);
    const attachments = mapUploadedFiles(req);

    if (!name) return res.status(400).json({ success: false, message: "name required" });
    if (!number) return res.status(400).json({ success: false, message: "number required" });
    if (!process_id) return res.status(400).json({ success: false, message: "process required" });

    await assertApprovedProcess(process_id);
    const dup = await duplicateMessage({ name, number });
    if (dup) return res.status(409).json({ success: false, message: dup });

    const row = await insertMachine({
      name,
      number,
      process_id,
      speed,
      duration,
      setup_time,
      make: make || null,
      model: model || null,
      remark: remark || null,
      created_by: auditUserName(req),
    });

    if (attachments.length) {
      await syncAttachmentList(MODULE, row.id, attachments, req);
    }

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
      return res.status(409).json({ success: false, message: `Machine ${/name/.test(err.constraint || "") ? "name" : "number"} already exists` });
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

    const input = {
      name: req.body?.name,
      number: req.body?.number,
      process_id: req.body?.process_id !== undefined ? parsePositiveIntId(req.body.process_id) : undefined,
      speed: req.body?.speed !== undefined ? normalizeSpeed(req.body.speed) : undefined,
      duration: hasTimeInput(req.body, "duration") ? parseSeconds(req.body, "duration") : undefined,
      setup_time: hasTimeInput(req.body, "setup_time") ? parseSeconds(req.body, "setup_time") : undefined,
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
        { field: "setup_time", normalize: (v) => Math.round(Number(v)) },
        { field: "make", normalize: (v) => (v == null || v === "" ? null : String(v).trim()) },
        { field: "model", normalize: (v) => (v == null || v === "" ? null : String(v).trim()) },
        { field: "remark", normalize: (v) => (v == null || v === "" ? null : String(v).trim()) },
      ],
    });

    const removeIds = parseRemoveAttachmentIds(req.body);
    await stampRmstoreUploadedFiles(req);
    const uploaded = mapUploadedFiles(req);
    const nextAttachments = mergeAttachments(existing.attachments, uploaded, removeIds);
    const hasAttachmentChanges = removeIds.length > 0 || uploaded.length > 0;
    const hasBusinessChanges = fieldChanges || hasAttachmentChanges;

    if (!hasBusinessChanges && normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    const fields = { ...preparedFields };

    if (fields.name !== undefined && !fields.name) {
      return res.status(400).json({ success: false, message: "name required" });
    }
    if (fields.number !== undefined && !fields.number) {
      return res.status(400).json({ success: false, message: "number required" });
    }
    if (fields.process_id !== undefined) {
      await assertApprovedProcess(fields.process_id);
    }
    // Only a name / number that actually changed is checked (old duplicates must not block other edits)
    const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
    const dup = await duplicateMessage({
      name: same(fields.name, existing.name) ? undefined : fields.name,
      number: same(fields.number, existing.number) ? undefined : fields.number,
    }, id);
    if (dup) return res.status(409).json({ success: false, message: dup });

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

    if (hasAttachmentChanges) {
      await syncAttachmentList(MODULE, id, nextAttachments, req);
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
      return res.status(409).json({ success: false, message: `Machine ${/name/.test(err.constraint || "") ? "name" : "number"} already exists` });
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

/** QR payload for print/download — public URL when base configured, else plain machine number. */
export const getMachineQr = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });

    const data = await findMachine({ id });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });
    if (!data.approved) {
      return res.status(400).json({ success: false, message: "Authorize machine before printing QR" });
    }

    const number = String(data.number || "").trim();
    if (!number) return res.status(400).json({ success: false, message: "Machine number is missing" });

    const qr_value = await resolveMachineQrPayload({ number });
    return res.json({
      success: true,
      data: {
        id: data.id,
        number,
        name: data.name,
        process_name: data.process_name,
        make: data.make,
        model: data.model,
        qr_value,
      },
    });
  } catch (err) {
    logger.error(`[eng_machine_master] qr error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};
