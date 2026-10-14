import {
  findProcesses, findProcess, insertProcess, updateProcess as updateProcessRow, softDeleteProcess,
  countActiveChildren, syncProcessDepth, findSiblingByName, loadTree, PROCESS_DEFAULT_FIELDS,
} from "../models/processMaster.model.js";
import { resolveParent, subtreeIds } from "../utils/processTree.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput, applyApprovalUpdateFields, prepareUpdateByRules } from "../../../../core/lib/utils/auth/approval.js";
import { assertWithinEditDays } from "../../../../core/lib/utils/auth/permissionDays.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import logger from "../../../../core/lib/utils/logging/logger.js";

const ENTITY = "eng_process_master";
const CFG = getCrudModuleConfig(ENTITY);
const STAGES = new Set(["START", "MID", "END"]);
const FLAGS = ["multi_jc", "rm_wire", "tooling", "fg", "prime", "rework"];

const log = (req, action, entity_id, details, record = null, existing = null) =>
  logActivity(req, { action, entity: ENTITY, entity_id, details, record, existing }).catch(() => {});

const toStage = (v) => {
  const s = String(v ?? "MID").trim().toUpperCase();
  return STAGES.has(s) ? s : "MID";
};
const toBool = (v) => v === true || v === "true" || v === 1 || v === "1";
const toName = (v) => String(v ?? "").trim();

/** Empty → null; otherwise must be a valid regular expression. */
function toPattern(v) {
  if (v == null || String(v).trim() === "") return null;
  const text = String(v).trim();
  try {
    new RegExp(text); // eslint-disable-line no-new
    return text;
  } catch {
    throw Object.assign(new Error("Invalid pattern — must be a valid regular expression"), { statusCode: 400 });
  }
}

const parentIdOf = (body) => (body?.parent_id == null || body.parent_id === "" ? null : parsePositiveIntId(body.parent_id));

/** Same name twice under one parent (or twice as a master) is not allowed. */
async function assertUniqueName(name, parentId, exceptId = null) {
  const dup = await findSiblingByName(name, parentId, exceptId);
  if (!dup) return;
  const where = parentId ? `under "${dup.parent_name}"` : "as a master process";
  throw Object.assign(new Error(`Process "${name}" already exists ${where}`), { statusCode: 409 });
}

/** Dropdown row (helper API). */
const toOption = (r) => ({
  id: r.id,
  name: r.name,
  label: r.name,
  path_label: r.path_label || r.name,
  depth: r.depth,
  stage: r.stage,
  parent_id: r.parent_id,
});

/** Wrap a handler: one place for the error log + status (400 from validation, else 500). */
const handle = (name, fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    if (err?.code === "23505" && /name_unique/.test(err.constraint || "")) Object.assign(err, { statusCode: 409, message: "Process with this name already exists under the same parent" });
    logger.error(`[${ENTITY}] ${name} error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const listProcesses = handle("list", async (req, res) => {
  const { page, limit, sortBy, order, search, filters } = extractListParams(req.body || {});
  const data = await findProcesses({
    filters: sanitizeFilters(filters, CFG?.filterFields || []),
    search: sanitizeSearch(search),
    sort: { by: sortBy, order },
    page,
    limit,
    fields: CFG?.listFields?.length ? CFG.listFields : PROCESS_DEFAULT_FIELDS,
  });
  return res.json({ success: true, data });
});

export const getProcess = handle("get", async (req, res) => {
  const id = parsePositiveIntId(req.body?.id);
  if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });
  const data = await findProcess(id);
  if (!data) return res.status(404).json({ success: false, message: "Not found" });
  return res.json({ success: true, data });
});

export const createProcess = handle("create", async (req, res) => {
  const body = req.body || {};
  const name = toName(body.name);
  if (!name) return res.status(400).json({ success: false, message: "name required" });

  const { parent_id, depth } = resolveParent(await loadTree(), parentIdOf(body));
  const fields = { name, parent_id, depth, stage: toStage(body.stage), pattern: toPattern(body.pattern), created_by: auditUserName(req) };
  for (const f of FLAGS) fields[f] = toBool(body[f]);

  await assertUniqueName(name, parent_id);

  const { id } = await insertProcess(fields);

  if (normalizeApprovedInput(body.approved) === true) {
    const approval = { updated_by: auditUserName(req), updated_at: new Date() };
    applyApprovalWorkflow({ req, fields: approval, incomingApproved: true, hasBusinessChanges: false, auditAsName: true, approvalTimestamp: new Date() });
    await updateProcessRow(id, approval);
  }

  const data = await findProcess(id);
  logger.info(`[${ENTITY}] create user=${req?.user?.id} id=${id} name=${name}`);
  await log(req, "create", id, { name, depth, parent_id }, data);
  return res.status(201).json({ success: true, data, message: "Process created successfully" });
});

export const updateProcess = handle("update", async (req, res) => {
  const body = req.body || {};
  const id = parsePositiveIntId(body.id);
  if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });

  const existing = await findProcess(id);
  if (!existing) return res.status(404).json({ success: false, message: "Not found" });

  const blocked = assertWithinEditDays(req, existing.created_at, "edit");
  if (blocked) return res.status(blocked.status).json({ success: false, message: blocked.message });

  const input = {
    name: body.name,
    stage: body.stage,
    pattern: body.pattern !== undefined ? toPattern(body.pattern) : undefined,
  };
  for (const f of FLAGS) input[f] = body[f];

  const { hasChanges, fields } = prepareUpdateByRules({
    existing,
    input,
    rules: [
      { field: "name", normalize: toName },
      { field: "stage", normalize: toStage },
      { field: "pattern", normalize: (v) => (v == null || v === "" ? null : String(v).trim()) },
      ...FLAGS.map((field) => ({ field, normalize: toBool })),
    ],
  });
  if (fields.name !== undefined && !fields.name) return res.status(400).json({ success: false, message: "name required" });

  let moved = false;
  if (body.parent_id !== undefined) {
    const { parent_id, depth } = resolveParent(await loadTree(), parentIdOf(body), id);
    moved = Number(existing.parent_id ?? 0) !== Number(parent_id ?? 0);
    if (moved) Object.assign(fields, { parent_id, depth });
  }

  const renamed = fields.name !== undefined && fields.name !== existing.name;
  if (renamed || moved) await assertUniqueName(fields.name ?? existing.name, moved ? fields.parent_id : existing.parent_id, id);

  const approved = normalizeApprovedInput(body.approved);
  if (!hasChanges && !moved && approved === undefined) {
    return res.status(400).json({ success: false, message: "No fields to update" });
  }

  applyApprovalUpdateFields({
    req,
    fields,
    incomingApproved: approved,
    hasBusinessChanges: hasChanges || moved,
    alreadyApproved: existing.approved === true,
    auditAsName: true,
  });

  await updateProcessRow(id, fields);
  // Parent changed → fix depth of its sub-processes. A rename needs nothing: path_label is built when reading.
  if (moved) await syncProcessDepth();

  const data = await findProcess(id);
  logger.info(`[${ENTITY}] update user=${req?.user?.id} id=${id} approved=${approved}`);
  await log(req, "update", id, { updated_fields: fields }, data, existing);
  return res.json({ success: true, data, message: "Process updated successfully" });
});

export const deleteProcess = handle("delete", async (req, res) => {
  const id = parsePositiveIntId(req.body?.id);
  if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });

  const existing = await findProcess(id);
  if (!existing) return res.status(404).json({ success: false, message: "Not found" });

  const children = await countActiveChildren(id);
  if (children > 0) {
    return res.status(409).json({ success: false, message: `Cannot delete — ${children} child process(es) still active` });
  }

  await softDeleteProcess(id, auditUserName(req));
  logger.info(`[${ENTITY}] delete user=${req?.user?.id} id=${id}`);
  await log(req, "delete", id, { name: existing.name }, existing);
  return res.json({ success: true, message: "Process deleted successfully" });
});

/** Dropdown: approved processes; `id` → that one row; `exclude_id` → hides it and its sub-processes (parent picker). */
export const listProcessViews = handle("helper", async (req, res) => {
  const body = req.body || {};
  const { page, limit, search, filters } = extractListParams(body);
  const safeFilters = sanitizeFilters(filters || {}, ["id", "approved", "parent_id", "stage", "depth", "fg", "prime"]);

  const byId = parsePositiveIntId(body.id ?? safeFilters.id);
  if (byId) {
    const row = await findProcess(byId);
    return res.json({ success: true, data: row ? [toOption(row)] : [], total: row ? 1 : 0 });
  }

  const excludeId = parsePositiveIntId(body.exclude_id);
  const { data, total } = await findProcesses({
    filters: { approved: true, ...safeFilters },
    search: sanitizeSearch(search),
    sort: { by: "id", order: "ASC" },
    page: page || 1,
    limit: limit || 50,
    excludeIds: excludeId ? subtreeIds(await loadTree(), excludeId) : [],
  });
  return res.json({ success: true, data: data.map(toOption), total });
});
