import {
  findProcesses, findProcess, insertProcess, updateProcess as updateProcessRow, softDeleteProcess,
  countActiveChildren, countMachinesForProcess, syncProcessDepth, findSiblingByName, loadTree, PROCESS_DEFAULT_FIELDS, PROCESS_FLAGS, flagsOf,
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
import { assertErpSync, nextErpMasterCode } from "../../../../core/lib/services/erpSync.js";
import { fetchEmpMaster } from "../../../../hrms/lib/erpApi.js";

const ENTITY = "eng_process_master";
const CFG = getCrudModuleConfig(ENTITY);
const STAGES = new Set(["START", "MID", "END"]);
const HELPER_FILTER_KEYS = ["proccode", "id", "approved", "parent_id", "stage", "depth", ...PROCESS_FLAGS];

const log = (req, action, entity_id, details, record = null, existing = null) =>
  logActivity(req, { action, entity: ENTITY, entity_id, details, record, existing }).catch(() => {});

const toStage = (v) => {
  const s = String(v ?? "MID").trim().toUpperCase();
  return STAGES.has(s) ? s : "MID";
};
const toBool = (v) => v === true || v === "true" || v === 1 || v === "1";
const toName = (v) => String(v ?? "").trim();

/** Empty → null; otherwise HRMS employee department name (ERP deptname). */
function toDeptname(v) {
  if (v == null || String(v).trim() === "") return null;
  return String(v).trim();
}

const parentIdOf = (body) => (body?.parent_id == null || body.parent_id === "" ? null : parsePositiveIntId(body.parent_id));
const codeOf = (body) => parsePositiveIntId(body?.proccode ?? body?.id);

/** Same name twice under one parent (or twice as a master) is not allowed. */
async function assertUniqueName(procname, parentId, exceptCode = null) {
  const dup = await findSiblingByName(procname, parentId, exceptCode);
  if (!dup) return;
  const where = parentId ? `under "${dup.parent_name}"` : "as a master process";
  throw Object.assign(new Error(`Process "${procname}" already exists ${where}`), { statusCode: 409 });
}

/** Dropdown row (helper API). */
const toOption = (r) => ({
  proccode: r.proccode,
  procname: r.procname,
  label: r.procname,
  path_label: r.path_label || r.procname,
  depth: r.depth,
  stage: r.stage,
  parent_id: r.parent_id,
  flags: flagsOf(r),
  ...flagsOf(r),
});

/** Wrap a handler: one place for the error log + status (400 from validation, else 500). */
const handle = (name, fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    if (err?.code === "23505" && /name_unique/.test(err.constraint || "")) {
      Object.assign(err, { statusCode: 409, message: "Process with this name already exists under the same parent" });
    }
    logger.error(`[${ENTITY}] ${name} error user=${req?.user?.id}: ${err?.message || err}`);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

const withConnectivityQuery = (filters, query) => {
  if (query?.connectivity == null || query.connectivity === "") return filters || {};
  return { ...(filters || {}), connectivity: query.connectivity };
};

export const listProcesses = handle("list", async (req, res) => {
  const { page, limit, sortBy, order, search, filters } = extractListParams(req.body || {});
  const data = await findProcesses({
    filters: sanitizeFilters(withConnectivityQuery(filters, req.query), CFG?.filterFields || []),
    search: sanitizeSearch(search),
    sort: { by: sortBy, order },
    page,
    limit,
    fields: CFG?.listFields?.length ? CFG.listFields : PROCESS_DEFAULT_FIELDS,
  });
  return res.json({ success: true, data });
});

export const getProcess = handle("get", async (req, res) => {
  const proccode = codeOf(req.body || {});
  if (!proccode) return res.status(400).json({ success: false, message: "Valid proccode required" });
  const data = await findProcess(proccode);
  if (!data) return res.status(404).json({ success: false, message: "Not found" });
  return res.json({ success: true, data });
});

export const createProcess = handle("create", async (req, res) => {
  const body = req.body || {};
  const procname = toName(body.procname ?? body.name);
  if (!procname) return res.status(400).json({ success: false, message: "procname required" });

  const { parent_id, depth } = resolveParent(await loadTree(), parentIdOf(body));
  const fields = {
    procname,
    parent_id,
    depth,
    stage: toStage(body.stage),
    deptname: toDeptname(body.deptname ?? body.pattern),
    created_by: auditUserName(req),
  };
  for (const f of PROCESS_FLAGS) fields[f] = toBool(body[f]);

  await assertUniqueName(procname, parent_id);

  const proccode = await nextErpMasterCode("mstproc");
  if (!proccode) {
    return res.status(502).json({ success: false, message: "Could not assign process code for ERP." });
  }
  await assertErpSync("add", { proccode, procname }, "mstproc");
  await insertProcess({ ...fields, proccode });

  if (normalizeApprovedInput(body.approved) === true) {
    const approval = { updated_by: auditUserName(req), updated_at: new Date() };
    applyApprovalWorkflow({ req, fields: approval, incomingApproved: true, hasBusinessChanges: false, auditAsName: true, approvalTimestamp: new Date() });
    await updateProcessRow(proccode, approval);
  }

  const data = await findProcess(proccode);
  logger.info(`[${ENTITY}] create user=${req?.user?.id} proccode=${proccode} procname=${procname}`);
  await log(req, "create", proccode, { procname, depth, parent_id }, data);
  return res.status(201).json({ success: true, data, message: "Process created successfully", erpSynced: true });
});

export const updateProcess = handle("update", async (req, res) => {
  const body = req.body || {};
  const proccode = codeOf(body);
  if (!proccode) return res.status(400).json({ success: false, message: "Valid proccode required" });

  const existing = await findProcess(proccode);
  if (!existing) return res.status(404).json({ success: false, message: "Not found" });

  const blocked = assertWithinEditDays(req, existing.created_at, "edit");
  if (blocked) return res.status(blocked.status).json({ success: false, message: blocked.message });

  const input = {
    procname: body.procname ?? body.name,
    stage: body.stage,
    deptname: body.deptname !== undefined || body.pattern !== undefined
      ? toDeptname(body.deptname ?? body.pattern)
      : undefined,
  };
  for (const f of PROCESS_FLAGS) input[f] = body[f];

  const { hasChanges, fields } = prepareUpdateByRules({
    existing,
    input,
    rules: [
      { field: "procname", normalize: toName },
      { field: "stage", normalize: toStage },
      { field: "deptname", normalize: toDeptname },
      ...PROCESS_FLAGS.map((field) => ({ field, normalize: toBool })),
    ],
  });
  if (fields.procname !== undefined && !fields.procname) {
    return res.status(400).json({ success: false, message: "procname required" });
  }

  let moved = false;
  if (body.parent_id !== undefined) {
    const { parent_id, depth } = resolveParent(await loadTree(), parentIdOf(body), proccode);
    moved = Number(existing.parent_id ?? 0) !== Number(parent_id ?? 0);
    if (moved) Object.assign(fields, { parent_id, depth });
  }

  const renamed = fields.procname !== undefined && fields.procname !== existing.procname;
  if (renamed || moved) {
    await assertUniqueName(fields.procname ?? existing.procname, moved ? fields.parent_id : existing.parent_id, proccode);
  }

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

  const procnameForErp = fields.procname ?? existing.procname;
  await assertErpSync("update", { proccode, procname: procnameForErp }, "mstproc");
  await updateProcessRow(proccode, fields);
  if (moved) await syncProcessDepth();

  const data = await findProcess(proccode);
  logger.info(`[${ENTITY}] update user=${req?.user?.id} proccode=${proccode} approved=${approved}`);
  await log(req, "update", proccode, { updated_fields: fields }, data, existing);
  return res.json({ success: true, data, message: "Process updated successfully", erpSynced: true });
});

export const deleteProcess = handle("delete", async (req, res) => {
  const proccode = codeOf(req.body || {});
  if (!proccode) return res.status(400).json({ success: false, message: "Valid proccode required" });

  const existing = await findProcess(proccode);
  if (!existing) return res.status(404).json({ success: false, message: "Not found" });

  const children = await countActiveChildren(proccode);
  if (children > 0) {
    return res.status(409).json({ success: false, message: `Cannot delete — ${children} child process(es) still linked` });
  }
  const linkedMac = await countMachinesForProcess(proccode);
  if (linkedMac > 0) {
    return res.status(409).json({ success: false, message: `Cannot delete — ${linkedMac} machine(s) still linked` });
  }

  const procname = existing.procname;
  await assertErpSync("delete", { proccode, procname }, "mstproc");
  await softDeleteProcess(proccode);
  logger.info(`[${ENTITY}] delete user=${req?.user?.id} proccode=${proccode}`);
  await log(req, "delete", proccode, { procname: existing.procname }, existing);
  return res.json({ success: true, message: "Process deleted successfully", erpSynced: true });
});

/** Dropdown: approved processes; `proccode` → that one row; `exclude_id` → hides it and its sub-processes (parent picker). */
export const listProcessViews = handle("helper", async (req, res) => {
  const body = req.body || {};
  const { page, limit, search, filters } = extractListParams(body);
  const safeFilters = sanitizeFilters(withConnectivityQuery(filters, req.query), HELPER_FILTER_KEYS);

  const byCode = parsePositiveIntId(body.proccode ?? body.id ?? safeFilters.proccode ?? safeFilters.id);
  if (byCode) {
    const row = await findProcess(byCode);
    return res.json({ success: true, data: row ? [toOption(row)] : [], total: row ? 1 : 0 });
  }

  const excludeId = parsePositiveIntId(body.exclude_id);
  const { data, total } = await findProcesses({
    filters: { approved: true, ...safeFilters },
    search: sanitizeSearch(search),
    sort: { by: "proccode", order: "ASC" },
    page: page || 1,
    limit: limit || 50,
    excludeIds: excludeId ? subtreeIds(await loadTree(), excludeId) : [],
  });
  return res.json({ success: true, data: data.map(toOption), total });
});

/** Distinct ERP employee departments for Process Master deptname picker (no HRMS route changes). */
function distinctDepartments(employees, search) {
  const byName = new Map();
  for (const r of employees) {
    const deptname = String(r.deptname ?? "").trim();
    if (!deptname) continue;
    const key = deptname.toLowerCase();
    if (byName.has(key)) continue;
    byName.set(key, { id: deptname, deptcode: r.deptcode ?? null, deptname, label: deptname });
  }
  let list = [...byName.values()].sort((a, b) =>
    a.deptname.localeCompare(b.deptname, undefined, { sensitivity: "base" })
  );
  const q = String(search ?? "").trim().toLowerCase();
  if (q) {
    list = list.filter((d) => d.deptname.toLowerCase().includes(q) || String(d.deptcode ?? "").toLowerCase().includes(q));
  }
  return list;
}

export const listProcessDepartments = handle("departments", async (req, res) => {
  const body = req.body || {};
  const lookup = String(body.id ?? body.deptname ?? "").trim();
  const employees = await fetchEmpMaster({});
  const all = distinctDepartments(employees);

  if (lookup) {
    const hit = all.find((d) => d.deptname.toLowerCase() === lookup.toLowerCase()) || { id: lookup, deptname: lookup, deptcode: null, label: lookup };
    return res.json({ success: true, data: hit });
  }

  const { page, limit, search } = extractListParams(body);
  const p = Math.max(1, Number(page) || 1);
  const n = Math.min(100, Math.max(1, Number(limit) || 50));
  const filtered = distinctDepartments(employees, search);
  const start = (p - 1) * n;
  return res.json({
    success: true,
    data: filtered.slice(start, start + n),
    total: filtered.length,
    page: p,
    limit: n,
  });
});
