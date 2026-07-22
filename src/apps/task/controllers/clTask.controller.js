import ClTask from "../models/clTask.model.js";
import RedTicket from "../models/redTicket.model.js";
import MisScore from "../models/misScore.model.js";
import { getISTDateString, normalizeDueTime, getClTaskFillBlockedReason, canSubmitPreviousTask, toYmd, getClTaskFillDeadlineYmd, isClTaskMissed } from "../helpers/clTaskTime.helper.js";
import { parseFormSchema, parseFormResponses, validateFormEntries, mergeEntryUploadedFiles, buildClAttachmentMeta, parseClAttachments, getOpenFills, archiveOpenFill, buildOpenFormResponses, getAwaitingOpenFills, approveOpenFillInResponses, rejectOpenFillInResponses } from "../helpers/clTaskForm.helper.js";
import { buildRecurrencePayload, validateClRecurrence, computeClNextOccurrence, computeClFirstOccurrence, clampDayOffset, parseRecurrenceArray, serializeClDate, isClOccurrenceDay } from "../helpers/clTaskRecurrence.helper.js";
import {
  parseIdList,
  resolveClMasterAssignees,
  userMatchesClMasterScope,
  getUserOrgIds,
} from "../helpers/clTaskAssignee.helper.js";
import {
  masterSnapshotForInstance,
  spawnInstancesForMasterDay,
} from "../helpers/clTaskSpawn.helper.js";
import { actorFromReq, logClTask, masterDeleteSnapshot } from "../services/clTaskLog.service.js";
import { getCachedPermissions, setCachedPermissions } from "../../../config/permissionCache.js";
import { assertWithinEditDays } from "../../core/utils/permissionDays.js";
import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { moduleSortOrderNumericExpr } from "../../core/utils/moduleSortOrderSql.js";

const MODULE_SORT_ORDER = moduleSortOrderNumericExpr("m");

async function loadUserModulePermissions(userId) {
  let permissions = getCachedPermissions(userId);
  if (permissions) return permissions;
  const perms = await dbQuery(
    `SELECT up.can_view, up.can_add, up.can_edit, up.can_delete, up.can_authorize, m.name as module_name
     FROM ${M.USER_PERMISSIONS} up
     JOIN ${M.MODULES} m ON m.id = up.module_id
     WHERE up.user_id = $1
       AND m.is_active = true
       AND up.is_deleted = false
     ORDER BY ${MODULE_SORT_ORDER} ASC, m.label ASC NULLS LAST, m.id ASC`,
    [userId],
  );
  permissions = perms || [];
  setCachedPermissions(userId, permissions);
  return permissions;
}

async function userHasClTaskCreateAccess(req) {
  const userType = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
  if (userType === "super_admin") return true;
  const perms = await loadUserModulePermissions(req.user.id);
  const mod = perms.find((p) => p.module_name === "cl_task_master" || p.module_name === "cl_task");
  return !!(mod && (mod.can_add === true || mod.can_add === "t" || mod.can_add === 1));
}

async function userHasClTaskEditAccess(req) {
  const userType = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
  if (userType === "super_admin") return true;
  const perms = await loadUserModulePermissions(req.user.id);
  const mod = perms.find((p) => p.module_name === "cl_task_master" || p.module_name === "cl_task");
  return !!(mod && (mod.can_edit === true || mod.can_edit === "t" || mod.can_edit === 1));
}

function canEditClSubmission(task, req, { viewerIsCreator = false, viewerCanEdit = false } = {}) {
  const uid = Number(req.user?.id);
  if (!uid || !task) return false;
  const userType = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
  if (userType === "super_admin") return true;
  if (viewerCanEdit) return true;
  if (Number(task.person_id) === uid) return true;
  if (Number(task.verification_user_id) === uid) return true;
  if (viewerIsCreator && Number(task.master_created_by) === uid) return true;
  return false;
}

function reqUserType(req) {
  return String(req.user?.type || req.user?.role || "").toLowerCase().trim();
}

function isSuperAdminUser(req) {
  return reqUserType(req) === "super_admin";
}

/** EA (executive_assistant) + super_admin see all verification rows. */
function canSeeAllVerificationTasks(req) {
  const t = reqUserType(req);
  return t === "super_admin" || t === "executive_assistant";
}

/**
 * Super Admin, Admin, and Executive Assistant can scope My CL to any assignee
 * (default own on the frontend; filters reveal all / other persons).
 */
function canSeeAllOpenClTasks(req) {
  const t = reqUserType(req);
  return t === "super_admin" || t === "admin" || t === "executive_assistant";
}

/** Alias — same privileged roles for My CL assignee scoping. */
function canScopeAllClMyTasks(req) {
  return canSeeAllOpenClTasks(req);
}

async function canFillOpenClTask(taskOrMaster, req) {
  const uid = Number(req.user?.id);
  if (!uid || !taskOrMaster) return false;
  if (String(taskOrMaster.task_type || "").toLowerCase() === "open" && canSeeAllOpenClTasks(req)) {
    return true;
  }
  // Instance already bound to a person
  if (taskOrMaster.instance_id != null || taskOrMaster._source === "instance") {
    return Number(taskOrMaster.person_id) === uid;
  }
  if (Number(taskOrMaster.person_id) === uid) return true;
  return userMatchesClMasterScope(taskOrMaster, uid);
}

function truthyPermFlag(v) {
  return v === true || v === "t" || v === 1 || v === "1";
}

async function userHasModuleAction(req, moduleName, actionFlag) {
  if (isSuperAdminUser(req)) return true;
  const perms = await loadUserModulePermissions(req.user.id);
  const mod = perms.find((p) => p.module_name === moduleName);
  if (!mod) return false;
  return truthyPermFlag(mod[actionFlag]);
}

/** Row scoped to assigned verifier, unless EA / super_admin. */
function canAccessVerificationInstance(task, req) {
  if (!task) return false;
  if (canSeeAllVerificationTasks(req)) return true;
  return Number(task.verification_user_id) === Number(req.user?.id);
}

const parseNumber = (value) => {
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
};

/** POST body preferred; GET query still works. */
function listParamsFromReq(req) {
  return { ...(req.query || {}), ...(req.body || {}) };
}

/** Body-first id for POST-only action routes (FormData-safe). */
function idFromReq(req, ...keys) {
  const body = req.body || {};
  const params = req.params || {};
  for (const key of keys) {
    const n = parseNumber(body[key] ?? params[key] ?? params.id);
    if (n) return n;
  }
  return null;
}

function parseBool(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (value === false || value === "false" || value === "0" || value === 0 || value === "f") return false;
  return true;
}

function isTruthyFlag(v) {
  return v === true || v === 1 || v === "1" || v === "t" || v === "true";
}

function serializeMasterRow(row) {
  if (!row) return row;
  const approved = isTruthyFlag(row.approved ?? row.is_active);
  return {
    ...row,
    approved,
    is_active: approved, // backward-compatible alias
    next_occurrence: serializeClDate(row.next_occurrence),
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at || row.activated_at || null,
    approved_by: row.approved_by || row.activated_by_name || null,
    approved_by_name: row.approved_by_name || row.approved_by || row.activated_by_name || null,
    day_offset: clampDayOffset(row.day_offset),
    sop_required: isTruthyFlag(row.sop_required),
    created_by_name: row.created_by_name || null,
    updated_by_name: row.updated_by_name || null,
  };
}

function serializeInstanceRow(row) {
  if (!row) return row;
  const scheduled = serializeClDate(row.scheduled_date);
  const dayOffset = clampDayOffset(row.day_offset);
  const normalized = { ...row, scheduled_date: scheduled, day_offset: dayOffset };
  const fillDeadline = row.task_type === "frequently"
    ? (getClTaskFillDeadlineYmd(normalized) || scheduled)
    : null;
  const fills = row.task_type === "open" ? getOpenFills(row.form_responses) : [];
  return {
    ...normalized,
    sop_required: isTruthyFlag(row.sop_required),
    sop_acknowledged: isTruthyFlag(row.sop_acknowledged),
    fill_deadline: fillDeadline,
    is_missed: isClTaskMissed(normalized),
    /** Open: completed fills kept on same instance (no extra rows). */
    fill_count: fills.length,
    fills,
  };
}

/** On activate: spawn due instance(s) and advance next_occurrence (frequently only).
 *  Open tasks stay on Task Master — assignee Due loads masters; submit creates a CL instance. */
async function spawnOnActivate(master) {
  const today = getISTDateString();

  if (master.task_type === "open") {
    await ClTask.updateNextOccurrence(master.cl_task_id, null);
    return;
  }

  if (master.task_type !== "frequently") return;

  let cursor = toYmd(master.next_occurrence) || computeClFirstOccurrence(master.day_offset);
  const recurrenceData = {
    recurrence_weekdays: parseRecurrenceArray(master.recurrence_weekdays),
    recurrence_month_dates: parseRecurrenceArray(master.recurrence_month_dates),
    recurrence_year_dates: parseRecurrenceArray(master.recurrence_year_dates),
  };

  let guard = 0;
  while (cursor && cursor <= today && guard < 60) {
    guard += 1;
    await spawnInstancesForMasterDay(master, cursor);
    cursor = computeClNextOccurrence(master.recurrence_type, recurrenceData, cursor);
  }

  await ClTask.updateNextOccurrence(master.cl_task_id, cursor);
}

/** Open master row for assignee Due (not an instance). */
function serializeOpenMasterDue(master) {
  if (!master) return null;
  const m = serializeMasterRow(master);
  return {
    ...m,
    instance_id: null,
    _source: "master",
    task_type: "open",
    status: "pending",
    scheduled_date: getISTDateString(),
    reject_count: 0,
    verifier_remark: null,
    person_remark: null,
    score: null,
    submitted_at: null,
    completed_at: null,
    form_responses: null,
    fill_count: 0,
    fills: [],
  };
}

/** Compact fill row for multi-submit timeline (WHEN + WHAT). */
function serializeSubmissionFill(row) {
  if (!row) return null;
  return {
    instance_id: row.instance_id,
    cl_task_id: row.cl_task_id,
    title: row.title,
    task_type: row.task_type,
    recurrence_type: row.recurrence_type,
    status: row.status,
    score: row.score,
    weightage: row.weightage ?? row.wastage ?? null,
    reject_count: row.reject_count ?? 0,
    scheduled_date: serializeClDate(row.scheduled_date),
    submitted_at: row.submitted_at,
    person_remark: row.person_remark,
    verifier_remark: row.verifier_remark,
    form_schema: row.form_schema,
    form_responses: row.form_responses,
    person_name: row.person_name,
    person_id: row.person_id,
    verification_user_name: row.verification_user_name,
  };
}

function hasSubmissionPayload(row) {
  /** Real submit only — pending shells without submitted_at are excluded. */
  return !!(row && row.submitted_at);
}

/**
 * All past/current fills for same master + person (Open multi-submit).
 * Frequently: only the opened instance — other schedule days are separate tasks.
 * Sorted oldest → newest by submitted_at.
 */
async function loadSubmissionFillsForTask(task) {
  if (!task?.cl_task_id || !task?.person_id) return [];
  const masterId = Number(task.cl_task_id);
  const personId = Number(task.person_id);
  const taskType = String(task.task_type || "").toLowerCase();

  if (taskType === "frequently" && task.instance_id) {
    return hasSubmissionPayload(task) ? [serializeSubmissionFill(task)].filter(Boolean) : [];
  }

  const rows = await ClTask.getInstances({
    cl_task_id: masterId,
    person_id: personId,
    page: 1,
    limit: 200,
    sortBy: "submitted_at",
    order: "ASC",
  });
  return (rows || [])
    .filter((r) => Number(r.cl_task_id) === masterId && Number(r.person_id) === personId)
    .filter(hasSubmissionPayload)
    .map(serializeSubmissionFill)
    .filter(Boolean)
    .filter((f, idx, arr) => {
      const id = Number(f.instance_id);
      return id && arr.findIndex((x) => Number(x.instance_id) === id) === idx;
    });
}

async function canViewSubmissionHistory(task, req) {
  const uid = Number(req.user?.id);
  if (!uid || !task) return false;
  if (canSeeAllVerificationTasks(req)) return true;
  if (canSeeAllOpenClTasks(req)) return true;
  if (Number(task.person_id) === uid) return true;
  if (Number(task.verification_user_id) === uid) return true;
  if (Number(task.master_created_by) === uid) return true;
  // Open multi/dept master on Due: person_id may be stamped as viewer, or null on raw master
  if (String(task.task_type || "").toLowerCase() === "open") {
    return userMatchesClMasterScope(task, uid);
  }
  return false;
}

/** Validate + normalize master payload from JSON or multipart body.
 *  One master stores assignment scope (dept / designation / person ids).
 *  Instances are created per person at spawn / open-submit time. */
function buildValidatedMasterFields(body) {
  const title = body.title;
  const task_type = body.task_type;
  const recurrence_type = body.recurrence_type;
  const weightage = body.weightage ?? body.wastage;
  const verification_user_id = body.verification_user_id;
  const department_id = body.department_id ? Number(body.department_id) : null;
  const designation_id = body.designation_id ? Number(body.designation_id) : null;
  const assigneePersonIds = parseIdList(body.assignee_person_ids ?? body.person_ids);
  let person_id = body.person_id ? Number(body.person_id) : null;
  const due_time = body.due_time;
  const form_schema = body.form_schema;
  const verification_required = body.verification_required;
  const description = body.description;
  const sop_description = body.sop_description;
  const sop_required = body.sop_required;
  const day_offset = body.day_offset;

  const parsedSchema = parseFormSchema(form_schema);

  if (!title?.trim()) {
    return { error: "Title is required" };
  }

  // Normalize: single person in list → person_id; multi → assignee_person_ids only
  let storedPersonIds = assigneePersonIds;
  if (!storedPersonIds.length && person_id) {
    storedPersonIds = [person_id];
  }
  if (storedPersonIds.length === 1) {
    person_id = storedPersonIds[0];
    storedPersonIds = [];
  } else if (storedPersonIds.length > 1) {
    person_id = null;
  }

  const hasDeptScope = !!department_id;
  const hasPersonScope = !!person_id || storedPersonIds.length > 0;
  if (!hasDeptScope && !hasPersonScope) {
    return { error: "Select a department or at least one person" };
  }
  if (designation_id && !department_id && !hasPersonScope) {
    return { error: "Department is required when designation is set" };
  }

  if (!task_type || !["open", "frequently"].includes(task_type)) {
    return { error: "Task type must be open or frequently" };
  }
  if (task_type === "frequently") {
    if (!recurrence_type) {
      return { error: "Recurrence type is required for frequently tasks" };
    }
    if (!["daily", "weekly", "monthly", "yearly"].includes(recurrence_type)) {
      return { error: "Recurrence type must be daily, weekly, monthly or yearly" };
    }
  }

  const recurrencePayload = task_type === "frequently"
    ? buildRecurrencePayload(body)
    : { recurrence_weekdays: [], recurrence_month_dates: [], recurrence_year_dates: [] };

  if (task_type === "frequently") {
    const recurErr = validateClRecurrence({ recurrence_type, ...recurrencePayload });
    if (recurErr) return { error: recurErr };
  }

  const weightageNum = Number(weightage);
  if (!weightageNum || weightageNum < 1 || weightageNum > 10) {
    return { error: "Weightage must be between 1 and 10" };
  }

  const needsVerification = parseBool(verification_required, true);
  if (needsVerification && !verification_user_id) {
    return { error: "Verification person is required" };
  }
  // Single person: assignee cannot verify themselves.
  // Multi-person: any user may be the verifier.
  // Dept/desig: external designated verifier only (checked against resolved assignees on create/update).
  const isMultiPerson = storedPersonIds.length > 1;
  if (
    !isMultiPerson &&
    needsVerification &&
    verification_user_id &&
    person_id &&
    Number(verification_user_id) === Number(person_id)
  ) {
    return { error: "Assignee cannot be the verification person" };
  }

  for (const field of parsedSchema) {
    if (!field.label?.trim()) {
      return {
        error: field.type === "section"
          ? "Section needs a title"
          : "All custom form fields must have a label",
      };
    }
  }

  const resolvedDueTime = task_type === "frequently"
    ? normalizeDueTime(due_time, "11:00")
    : null;

  const sopRequired = parseBool(sop_required, false);
  if (sopRequired && !String(sop_description || "").replace(/<[^>]+>/g, "").trim()) {
    return { error: "SOP content is required when SOP acknowledgment is required" };
  }

  return {
    data: {
      title: title.trim(),
      description: description || null,
      sop_description: sop_description || null,
      sop_required: sopRequired,
      task_type,
      recurrence_type: task_type === "frequently" ? recurrence_type : null,
      ...recurrencePayload,
      weightage: weightageNum,
      verification_user_id: verification_user_id || null,
      department_id: department_id || null,
      designation_id: designation_id || null,
      person_id: person_id || null,
      assignee_person_ids: storedPersonIds.length ? storedPersonIds : null,
      due_time: task_type === "frequently" ? (resolvedDueTime || "11:00") : null,
      day_offset: task_type === "frequently" ? clampDayOffset(day_offset) : 0,
      form_schema: parsedSchema,
      verification_required: needsVerification,
      scoring_enabled: needsVerification,
    },
  };
}

export async function getClTasks(req, res) {
  try {
    const {
      search = "",
      page = 1,
      limit = 1000,
      sortBy = "cl_task_id",
      order = "DESC",
      department_id,
      designation_id,
      person_id,
      task_type,
      is_active,
      approved,
    } = listParamsFromReq(req);

    let approvedFilter;
    const approvedRaw = approved !== undefined && approved !== "" ? approved : is_active;
    if (approvedRaw === "true" || approvedRaw === true || approvedRaw === "1") approvedFilter = true;
    if (approvedRaw === "false" || approvedRaw === false || approvedRaw === "0") approvedFilter = false;

    const filterParams = {
      search,
      page: parseNumber(page) || 1,
      limit: Math.min(parseNumber(limit) || 1000, 5000),
      sortBy,
      order: String(order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC",
      department_id: parseNumber(department_id),
      designation_id: parseNumber(designation_id),
      person_id: parseNumber(person_id),
      task_type: task_type && task_type !== "all" ? task_type : undefined,
      approved: approvedFilter,
    };

    const viewDays = Number(req.permission?.can_view_days) || 0;
    if (viewDays > 0 && !isSuperAdminUser(req)) {
      filterParams.view_days = viewDays;
    }

    const [items, total, stats] = await Promise.all([
      ClTask.getMasters(filterParams),
      ClTask.countMasters(filterParams),
      ClTask.getMasterStats({
        department_id: filterParams.department_id,
        designation_id: filterParams.designation_id,
        person_id: filterParams.person_id,
        search: filterParams.search,
        view_days: filterParams.view_days,
      }),
    ]);

    res.json({
      success: true,
      message: "CL tasks fetched successfully",
      data: {
        page: filterParams.page,
        limit: filterParams.limit,
        total,
        totalPages: Math.ceil(total / filterParams.limit),
        data: (items ?? []).map(serializeMasterRow),
        stats: stats ?? { total: 0, active: 0, inactive: 0, open: 0, frequently: 0 },
      },
    });
  } catch (err) {
    console.error("getClTasks:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch CL tasks" });
  }
}


/** Heal open instances stuck in awaiting_verification (pre fill-archive model). */
async function healOpenAwaitingToPending(userId) {
  try {
    const stuck = await ClTask.getInstances({
      userId,
      task_type: "open",
      status: "awaiting_verification",
      page: 1,
      limit: 200,
    });
    for (const row of stuck || []) {
      const { formResponses } = archiveOpenFill(row.form_responses, {
        score: null,
        rejectCount: Number(row.reject_count) || 0,
        personRemark: row.person_remark,
        submittedAt: row.submitted_at || new Date().toISOString(),
        status: "awaiting_verification",
      });
      await ClTask.completeOpenAndReopen(row.instance_id, {
        formResponses,
        personRemark: row.person_remark,
      });
    }
  } catch (e) {
    console.error("healOpenAwaitingToPending:", e.message || e);
  }
}

export async function getMyClTasks(req, res) {
  try {
    const {
      tab = "due",
      panel,
      page = 1,
      limit = 200,
      sortBy = "scheduled_date",
      order = "ASC",
      search = "",
      recurrence_type = "",
      status = "",
      date_from = "",
      date_to = "",
      fromDate = "",
      toDate = "",
    } = listParamsFromReq(req);

    const validTabs = ["due", "today", "open", "frequently", "history", "submitted", "previous", "future"];
    const validPanels = ["due", "open_type", "frequently", "submitted"];
    const finalPanel = validPanels.includes(panel) ? panel : undefined;
    const finalTab = finalPanel ? undefined : (validTabs.includes(tab) ? tab : "due");

    const isHistory = finalTab === "history" || finalTab === "submitted" || finalPanel === "submitted";
    const isDue =
      finalTab === "due" ||
      finalTab === "today" ||
      finalTab === "open" ||
      finalPanel === "due" ||
      finalPanel === "open_type";

    const filterParams = {
      search,
      page: parseNumber(page) || 1,
      limit: Math.min(parseNumber(limit) || 1000, 5000),
      sortBy: isHistory && (!sortBy || sortBy === "scheduled_date") ? "submitted_at" : sortBy,
      order: (() => {
        const o = String(order || "").toUpperCase();
        if (o === "DESC" || o === "ASC") return o;
        return isHistory ? "DESC" : "ASC";
      })(),
      recurrence_type:
        (finalTab === "frequently" || finalPanel === "frequently") && recurrence_type
          ? String(recurrence_type).toLowerCase()
          : undefined,
      // Privileged: load all assignees so FE can filter (default = own). Others: own only.
      userId: canScopeAllClMyTasks(req) ? undefined : req.user.id,
    };

    const viewDays = Number(req.permission?.can_view_days) || 0;
    if (viewDays > 0 && !isSuperAdminUser(req)) {
      filterParams.view_days = viewDays;
    }

    if (isHistory) {
      filterParams.tab = "history";
      const st = String(status || "").toLowerCase();
      if (st === "awaiting_verification" || st === "pending") {
        filterParams.status = "awaiting_verification";
      } else if (st === "completed" || st === "verified") {
        filterParams.status = "completed";
      }
      const from = date_from || fromDate || "";
      const to = date_to || toDate || "";
      if (from) filterParams.date_from = String(from).slice(0, 10);
      if (to) filterParams.date_to = String(to).slice(0, 10);
      filterParams.date_field = "submitted_at";
    } else {
      filterParams.tab = finalTab;
      filterParams.panel = finalPanel;
    }

    // Due: ensure frequent clones exist (cron may have missed / lastCloneDate blocked).
    // Open tasks stay on masters — frequently Due = instances only.
    if (isDue) {
      try {
        const { runClClone } = await import("../../../jobs/clTasks.cron.js");
        await runClClone({
          reason: "due-list",
          personId: canScopeAllClMyTasks(req) ? null : req.user.id,
        });
      } catch (e) {
        console.error("getMyClTasks frequent clone catch-up:", e.message || e);
      }
    }

    const [instanceItems, instanceTotal, stats] = await Promise.all([
      ClTask.getInstances(filterParams),
      ClTask.countInstances(filterParams),
      ClTask.getMyTabStats(req.user.id),
    ]);

    let data = (instanceItems ?? []).map(serializeInstanceRow);

    // Due / Open tab: include OPEN Task Masters only (never frequently masters).
    // Privileged: all approved open masters (FE filters by person). Others: own only.
    if (isDue) {
      try {
        const openMasterFilters = {
          task_type: "open",
          approved: true,
          search: search || undefined,
          page: 1,
          limit: 5000,
          sortBy: "title",
          order: "ASC",
        };
        if (!canScopeAllClMyTasks(req)) {
          // Scope match (dept / desig / person / assignee_person_ids) — not person_id only
          openMasterFilters.person_id = undefined;
        }
        const openMasters = await ClTask.getMasters(openMasterFilters);
        const uid = Number(req.user.id);
        const scopedMasters = [];
        for (const m of openMasters || []) {
          if (!m || String(m.task_type) !== "open") continue;
          if (canScopeAllClMyTasks(req) || (await userMatchesClMasterScope(m, uid))) {
            scopedMasters.push(m);
          }
        }
        const masterRows = scopedMasters
          .map((m) => {
            const row = serializeOpenMasterDue(m);
            if (!row) return null;
            // Stamp viewer as assignee so fill history / FE person filters work for multi/dept masters
            if (!canScopeAllClMyTasks(req)) {
              row.person_id = uid;
              row.person_name = req.user?.name || row.person_name || null;
            }
            return row;
          })
          .filter(Boolean);
        // Frequently must have instance_id (clone). Drop any master-shaped frequent rows.
        const instanceRows = data.filter(
          (r) => r.task_type !== "frequently" || r.instance_id != null,
        );
        data = [...masterRows, ...instanceRows];
      } catch (e) {
        console.error("getMyClTasks open masters:", e.message || e);
      }
    }

    const total = isDue ? data.length : instanceTotal;

    res.json({
      success: true,
      message: "My CL tasks fetched successfully",
      data: {
        page: filterParams.page,
        limit: filterParams.limit,
        total,
        totalPages: Math.ceil(total / filterParams.limit) || 1,
        data,
        stats,
        can_submit_previous: canSubmitPreviousTask(),
        can_edit_history: true,
        can_see_all_open: canScopeAllClMyTasks(req),
        can_filter_all_assignees: canScopeAllClMyTasks(req),
        ist_hour: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "numeric", hour12: true }),
      },
    });
  } catch (err) {
    console.error("getMyClTasks:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch my CL tasks" });
  }
}

/**
 * One instance (or latest fill for a master) + full submission_fills timeline.
 * Body: { instance_id } OR { cl_task_id, person_id? }
 */
export async function getClTaskInstanceDetail(req, res) {
  try {
    const body = req.body || {};
    const instanceId = Number(body.instance_id || body.id);
    const clTaskId = Number(body.cl_task_id);
    const personIdHint = Number(body.person_id) || Number(req.user?.id);

    let task = null;
    if (instanceId) {
      task = await ClTask.getInstanceById(instanceId);
    } else if (clTaskId) {
      const rows = await ClTask.getInstances({
        cl_task_id: clTaskId,
        person_id: personIdHint,
        page: 1,
        limit: 200,
        sortBy: "submitted_at",
        order: "DESC",
      });
      task = (rows || []).find(hasSubmissionPayload) || null;
      if (!task) {
        const master = await ClTask.getMasterById(clTaskId);
        if (!master) {
          return res.status(404).json({ success: false, message: "Task not found" });
        }
        if (!(await canViewSubmissionHistory({ ...master, master_created_by: master.created_by }, req))) {
          return res.status(403).json({ success: false, message: "Not allowed to view this task" });
        }
        return res.json({
          success: true,
          data: {
            ...serializeOpenMasterDue(master),
            person_id: personIdHint || master.person_id,
            submission_fills: [],
            sibling_fills: [],
            fill_count: 0,
          },
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        message: "instance_id or cl_task_id required",
      });
    }

    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    if (!(await canViewSubmissionHistory(task, req))) {
      return res.status(403).json({ success: false, message: "Not allowed to view this task" });
    }

    const submission_fills = await loadSubmissionFillsForTask(task);
    const currentId = Number(task.instance_id);
    const sibling_fills = submission_fills.filter((f) => Number(f.instance_id) !== currentId);

    res.json({
      success: true,
      data: {
        ...serializeInstanceRow(task),
        submission_fills,
        sibling_fills,
        fill_count: submission_fills.length,
      },
    });
  } catch (err) {
    console.error("getClTaskInstanceDetail:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch submission history" });
  }
}

export async function getVerificationClTasks(req, res) {
  try {
    const {
      page = 1,
      limit = 1000,
      search = "",
      sortBy = "submitted_at",
      order = "DESC",
      status = "approval",
      department_id,
      designation_id,
      person_id,
    } = listParamsFromReq(req);

    /** UI: All / Due / Missed / Approval / Complete */
    const statusMap = {
      all: null,
      due: "pending",
      pending: "pending",
      missed: "pending",
      approval: "awaiting_verification",
      awaiting_verification: "awaiting_verification",
      complete: "completed",
      completed: "completed",
      verified: "completed",
    };
    const rawStatus = String(status || "approval").toLowerCase().trim();
    const resolvedStatus = Object.prototype.hasOwnProperty.call(statusMap, rawStatus)
      ? statusMap[rawStatus]
      : "awaiting_verification";

    const filterParams = {
      search,
      page: parseNumber(page) || 1,
      limit: Math.min(parseNumber(limit) || 1000, 5000),
      sortBy,
      order: String(order || "DESC").toUpperCase() === "DESC" ? "DESC" : "ASC",
      department_id: parseNumber(department_id),
      designation_id: parseNumber(designation_id),
      person_id: parseNumber(person_id),
    };
    /** Normal users: only own verification queue. Super admin + EA: everyone. */
    if (!canSeeAllVerificationTasks(req)) {
      filterParams.verification_user_id = req.user.id;
    }
    const viewDays = Number(req.permission?.can_view_days) || 0;
    if (viewDays > 0 && !isSuperAdminUser(req)) {
      filterParams.view_days = viewDays;
    }
    if (rawStatus === "missed") {
      filterParams.panel = "missed";
      filterParams.status = "pending";
    } else if (rawStatus === "due" || rawStatus === "pending") {
      /** Verification Due = frequently fillable only (no open). */
      filterParams.panel = "due_frequently";
      filterParams.status = "pending";
    } else if (resolvedStatus) {
      filterParams.status = resolvedStatus;
    } else {
      filterParams.status_in = ["pending", "awaiting_verification", "completed"];
    }

    const [items, total] = await Promise.all([
      ClTask.getInstances(filterParams),
      ClTask.countInstances(filterParams),
    ]);

    res.json({
      success: true,
      message: "Verification CL tasks fetched successfully",
      data: {
        page: filterParams.page,
        limit: filterParams.limit,
        total,
        totalPages: Math.ceil(total / filterParams.limit) || 1,
        data: (items ?? []).map(serializeInstanceRow),
        status_filter: resolvedStatus || "all",
        scope: canSeeAllVerificationTasks(req) ? "all" : "own",
      },
    });
  } catch (err) {
    console.error("getVerificationClTasks:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch verification tasks" });
  }
}


export async function createClTask(req, res) {
  try {
    const actor = actorFromReq(req);
    /** Optional audit only — clone is a normal create from FE-copied fields (no time / meta gate). */
    const clonedFromId = parseNumber(req.body.cloned_from_id);

    const built = buildValidatedMasterFields(req.body);
    if (built.error) {
      return res.status(400).json({ success: false, message: built.error });
    }

    const assignees = await resolveClMasterAssignees(built.data);
    if (!assignees.length) {
      return res.status(400).json({
        success: false,
        message: built.data.department_id
          ? "No active users found for this department / designation"
          : "No active assignees found",
      });
    }
    const isMultiPerson = (built.data.assignee_person_ids || []).length > 1;
    if (
      !isMultiPerson &&
      built.data.verification_required &&
      built.data.verification_user_id &&
      assignees.some((u) => Number(u.id) === Number(built.data.verification_user_id))
    ) {
      return res.status(400).json({
        success: false,
        message: "Assignee cannot be the verification person",
      });
    }

    const uploaded = (req.files || []).map(buildClAttachmentMeta).filter(Boolean);
    const kept = parseClAttachments(req.body.existing_attachments ?? req.body.attachment);
    const attachment = [...kept, ...uploaded];

    // Active on create — spawn first due instance(s) immediately.
    const nextOccurrence =
      built.data.task_type === "frequently"
        ? computeClFirstOccurrence(built.data.day_offset)
        : null;

    const masterData = {
      ...built.data,
      next_occurrence: nextOccurrence,
      approved: true,
      approved_by: actor.name,
      approved_at: new Date(),
      created_by: actor.id,
      created_by_name: actor.name,
      attachment: attachment.length ? attachment : null,
    };

    const clTaskId = await ClTask.createMaster(masterData);
    const master = await ClTask.getMasterById(clTaskId);
    try {
      await spawnOnActivate(master);
    } catch (spawnErr) {
      console.error("createClTask spawn:", spawnErr.stack || spawnErr);
    }
    const after = await ClTask.getMasterById(clTaskId);

    await logClTask(req, {
      action: clonedFromId ? "clone" : "create",
      entity_id: clTaskId,
      record: after || master,
      details: {
        title: built.data.title,
        cloned_from_id: clonedFromId || null,
        approved: true,
      },
    });

    res.status(201).json({
      success: true,
      message: clonedFromId ? "CL task created from clone" : "CL task created and activated",
      data: {
        cl_task_id: clTaskId,
        approved: true,
        next_occurrence: serializeClDate(after?.next_occurrence ?? nextOccurrence),
      },
    });
  } catch (err) {
    console.error("createClTask:", err.stack || err);
    res.status(500).json({ success: false, message: err.message || "Failed to create CL task" });
  }
}

/**
 * Update master template only.
 * Existing (Day-1 / past) instances stay frozen; future cron instances get the new snapshot.
 */
export async function updateClTask(req, res) {
  try {
    const id = idFromReq(req, "cl_task_id", "id");
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid CL task id" });
    }

    const existing = await ClTask.getMasterById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }

    const editDaysBlocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (editDaysBlocked) {
      return res.status(editDaysBlocked.status).json({ success: false, message: editDaysBlocked.message });
    }

    const built = buildValidatedMasterFields(req.body);
    if (built.error) {
      return res.status(400).json({ success: false, message: built.error });
    }

    const assignees = await resolveClMasterAssignees(built.data);
    if (!assignees.length) {
      return res.status(400).json({
        success: false,
        message: built.data.department_id
          ? "No active users found for this department / designation"
          : "No active assignees found",
      });
    }
    const isMultiPerson = (built.data.assignee_person_ids || []).length > 1;
    if (
      !isMultiPerson &&
      built.data.verification_required &&
      built.data.verification_user_id &&
      assignees.some((u) => Number(u.id) === Number(built.data.verification_user_id))
    ) {
      return res.status(400).json({
        success: false,
        message: "Assignee cannot be the verification person",
      });
    }

    const kept =
      req.body.existing_attachments != null
        ? parseClAttachments(req.body.existing_attachments)
        : parseClAttachments(existing.attachment);
    const uploaded = (req.files || []).map(buildClAttachmentMeta).filter(Boolean);
    const attachment = [...kept, ...uploaded];

    const actor = actorFromReq(req);
    const payload = {
      ...built.data,
      attachment: attachment.length ? attachment : null,
      updated_by: actor.id,
      updated_by_name: actor.name,
    };

    await ClTask.updateMaster(id, payload);
    // Pending assigned tasks get latest form / SOP / attachment so assignee sees fields
    await ClTask.syncPendingInstancesFromMaster(id, payload);

    // Reconcile assignee scope: drop pending for removed people; spawn today for new ones
    const allowedIds = assignees.map((u) => Number(u.id));
    await ClTask.deletePendingInstancesNotInPersons(id, allowedIds);

    const refreshed = await ClTask.getMasterById(id);
    if (
      refreshed &&
      isTruthyFlag(refreshed.approved ?? refreshed.is_active) &&
      refreshed.task_type === "frequently"
    ) {
      const today = getISTDateString();
      const recurrenceData = {
        recurrence_weekdays: parseRecurrenceArray(refreshed.recurrence_weekdays),
        recurrence_month_dates: parseRecurrenceArray(refreshed.recurrence_month_dates),
        recurrence_year_dates: parseRecurrenceArray(refreshed.recurrence_year_dates),
      };
      if (isClOccurrenceDay(refreshed.recurrence_type, recurrenceData, today)) {
        await spawnInstancesForMasterDay(refreshed, today);
      }
    }

    await logClTask(req, {
      action: "update",
      entity_id: id,
      record: { cl_task_id: id, title: built.data.title },
      details: {
        title: built.data.title,
        task_type: built.data.task_type,
        person_id: built.data.person_id,
        day_offset: built.data.day_offset,
        assignee_count: assignees.length,
      },
    });

    const recurrenceData = {
      recurrence_weekdays: built.data.recurrence_weekdays,
      recurrence_month_dates: built.data.recurrence_month_dates,
      recurrence_year_dates: built.data.recurrence_year_dates,
    };

    if (built.data.task_type === "open") {
      await ClTask.updateNextOccurrence(id, null);
    } else if (built.data.task_type === "frequently") {
      const instanceCount = Number(existing.instance_count) || 0;
      if (!isTruthyFlag(existing.approved ?? existing.is_active) && instanceCount === 0) {
        await ClTask.updateNextOccurrence(id, computeClFirstOccurrence(built.data.day_offset));
      } else if (isTruthyFlag(existing.approved ?? existing.is_active)) {
        const today = getISTDateString();
        const nextDate = computeClNextOccurrence(built.data.recurrence_type, recurrenceData, today);
        await ClTask.updateNextOccurrence(id, nextDate);
      }
    }

    res.json({
      success: true,
      message: "CL task updated — pending assigned tasks refreshed with latest form; completed stay unchanged",
      data: { cl_task_id: id },
    });
  } catch (err) {
    console.error("updateClTask:", err.stack || err);
    res.status(500).json({ success: false, message: err.message || "Failed to update CL task" });
  }
}

export async function submitClTask(req, res) {
  try {
    let id = idFromReq(req, "instance_id", "id");
    const masterId = idFromReq(req, "cl_task_id");
    const person_remark = req.body.person_remark;
    const userId = req.user.id;

    /**
     * Open Task Master on Due: create a CL instance for this fill, then submit it.
     * Frequently always uses an existing instance from the CL task table.
     */
    if (!id && masterId) {
      const master = await ClTask.getMasterById(masterId);
      if (!master) {
        return res.status(404).json({ success: false, message: "CL task master not found" });
      }
      if (master.task_type !== "open") {
        return res.status(400).json({
          success: false,
          message: "Only open tasks submit from Task Master; frequently uses Due instances",
        });
      }
      if (!isTruthyFlag(master.approved ?? master.is_active)) {
        return res.status(400).json({ success: false, message: "This open task is not active" });
      }
      if (!(await canFillOpenClTask(master, req))) {
        return res.status(403).json({ success: false, message: "You are not assigned to this task" });
      }
      const org = await getUserOrgIds(userId);
      const snap = masterSnapshotForInstance(master, getISTDateString(), {
        id: userId,
        department_id: org?.department_id ?? null,
        designation_id: org?.designation_id ?? null,
      });
      id = await ClTask.createInstance(snap);
    }

    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid instance id" });
    }

    const task = await ClTask.getInstanceById(id);
    if (!task) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }
    const isOpenTask = String(task.task_type || "").toLowerCase() === "open";
    if (isOpenTask) {
      if (!(await canFillOpenClTask(task, req))) {
        return res.status(403).json({ success: false, message: "You are not assigned to this task" });
      }
    } else if (Number(task.person_id) !== Number(userId)) {
      return res.status(403).json({ success: false, message: "You are not assigned to this task" });
    }
    if (task.status !== "pending") {
      return res.status(400).json({
        success: false,
        message:
          task.status === "awaiting_verification"
            ? "Already submitted for this cycle — open History to correct values"
            : "This cycle is already completed",
      });
    }

    const fillBlocked = getClTaskFillBlockedReason(task);
    if (fillBlocked) {
      return res.status(400).json({ success: false, message: fillBlocked });
    }

    const sopRequired = task.sop_required === true;
    const sopAckRaw = req.body.sop_acknowledged;
    const sopAcknowledged =
      sopAckRaw === true || sopAckRaw === "true" || sopAckRaw === 1 || sopAckRaw === "1";
    if (sopRequired && !sopAcknowledged) {
      return res.status(400).json({
        success: false,
        message: "Please acknowledge that you have read the SOP before submitting",
      });
    }

    const schema = parseFormSchema(task.form_schema);
    const parsed = parseFormResponses(req.body.form_responses);
    let entries = Array.isArray(parsed.entries) ? parsed.entries : [];

    if (task.task_type === "frequently" && entries.length > 1) {
      return res.status(400).json({
        success: false,
        message: "Frequently tasks allow only one form entry per occurrence",
      });
    }

    if (!entries.length && schema.length) {
      return res.status(400).json({ success: false, message: "At least one form entry is required" });
    }

    entries = mergeEntryUploadedFiles(entries, req.files || []);

    const validationErrors = validateFormEntries(schema, entries);
    if (validationErrors.length) {
      return res.status(400).json({ success: false, message: validationErrors[0] });
    }

    const needsVerification = task.verification_required !== false;
    const formPayload = schema.length ? { entries } : {};

    await ClTask.submitInstance(id, {
      personRemark: person_remark,
      formResponses: formPayload,
      directComplete: !needsVerification,
      sopAcknowledged: sopRequired ? true : sopAcknowledged,
    });

    await logClTask(req, {
      action: "submit",
      entity_id: task.cl_task_id,
      record: { cl_task_id: task.cl_task_id, title: task.title, instance_id: Number(id) },
      details: {
        instance_id: Number(id),
        direct_complete: !needsVerification,
        sop_acknowledged: sopRequired ? true : !!sopAcknowledged,
        from_open_master: !!masterId && task.task_type === "open",
      },
    });

    res.json({
      success: true,
      message: needsVerification
        ? task.task_type === "open"
          ? "Open fill submitted — task stays on Due for more fills"
          : "Task submitted for verification"
        : task.task_type === "open"
          ? "Open fill saved — task stays on Due for more fills"
          : "Task completed successfully",
      data: {
        instance_id: Number(id),
        open_task_still_available: task.task_type === "open",
      },
    });
  } catch (err) {
    console.error("submitClTask:", err.stack || err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to submit task",
    });
  }
}

export async function updateClTaskSubmission(req, res) {
  try {
    const id = idFromReq(req, "instance_id", "id");
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid instance id" });
    }

    const task = await ClTask.getInstanceById(id);
    if (!task) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }

    const verifCanEdit = await userHasModuleAction(req, "cl_task_verification", "can_edit");
    const verifCanAuthorize = await userHasModuleAction(req, "cl_task_verification", "can_authorize");
    const verifScopeOk = canAccessVerificationInstance(task, req);
    const isSuper = isSuperAdminUser(req);
    const isCompleted = task.status === "completed";

    /**
     * Completed submissions: Super Admin always; else authorize + verification scope.
     * Status must stay completed.
     */
    if (isCompleted) {
      if (!isSuper && !(verifScopeOk && verifCanAuthorize)) {
        return res.status(403).json({
          success: false,
          message: "Only Super Admin (or Approve permission) can update a completed task",
        });
      }
    } else if (!["awaiting_verification", "pending"].includes(task.status)) {
      return res.status(400).json({
        success: false,
        message: "Only pending verification (or rejected) submissions can be edited",
      });
    }

    const viewerIsCreator = await userHasClTaskCreateAccess(req);
    const viewerCanEdit = await userHasClTaskEditAccess(req);
    /** Super Admin always; EDIT before verify; APPROVE before and after verify. */
    const viaVerification =
      isSuper ||
      (verifScopeOk && (verifCanAuthorize || (verifCanEdit && !isCompleted)));

    if (!viaVerification && !canEditClSubmission(task, req, { viewerIsCreator, viewerCanEdit })) {
      return res.status(403).json({
        success: false,
        message: "Only the assignee, verifier, task creator, or CL task editors can edit this submission",
      });
    }

    const schema = parseFormSchema(task.form_schema);
    const parsed = parseFormResponses(req.body.form_responses);
    let entries = Array.isArray(parsed.entries) ? parsed.entries : [];

    if (task.task_type === "frequently" && entries.length > 1) {
      return res.status(400).json({
        success: false,
        message: "Frequently tasks allow only one form entry per occurrence",
      });
    }

    entries = mergeEntryUploadedFiles(entries, req.files || []);
    if (schema.length) {
      const validationErrors = validateFormEntries(schema, entries);
      if (validationErrors.length) {
        return res.status(400).json({ success: false, message: validationErrors[0] });
      }
    }

    const actor = actorFromReq(req);
    /** Never flip completed back to awaiting; keep awaiting if already there; else resubmit flag. */
    let keepAwaiting = false;
    if (task.status === "awaiting_verification") {
      keepAwaiting = true;
    } else if (task.status === "completed") {
      keepAwaiting = false;
    } else {
      keepAwaiting = String(req.body.resubmit_for_verification) !== "false";
    }

    await ClTask.updateSubmission(id, {
      formResponses: task.task_type === "open"
        ? buildOpenFormResponses({
            entries: schema.length ? entries : [],
            fills: getOpenFills(task.form_responses),
          })
        : (schema.length ? { entries } : (parsed || {})),
      personRemark: req.body.person_remark,
      verifierRemark: req.body.verifier_remark,
      editNote: req.body.edit_note,
      actor,
      keepAwaiting,
    });

    await logClTask(req, {
      action: "submission_edit",
      entity_id: task.cl_task_id,
      record: { cl_task_id: task.cl_task_id, title: task.title, instance_id: id },
      details: {
        instance_id: id,
        edited_by: actor.name,
        keep_awaiting: keepAwaiting,
        status: task.status,
      },
    });

    const after = await ClTask.getInstanceById(id);
    res.json({
      success: true,
      message: "Submission updated",
      data: serializeInstanceRow(after),
    });
  } catch (err) {
    console.error("updateClTaskSubmission:", err.stack || err);
    res.status(500).json({ success: false, message: err.message || "Failed to update submission" });
  }
}

export async function verifyClTask(req, res) {
  try {
    const id = idFromReq(req, "instance_id", "id");
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid instance id" });
    }
    const { action, score, verifier_remark, create_red_ticket, fill_id } = req.body;

    /** Only ADD (can_add) may approve / reject — EDIT and APPROVE are update-only. */
    const canAdd = await userHasModuleAction(req, "cl_task_verification", "can_add");
    if (!canAdd && !isSuperAdminUser(req)) {
      return res.status(403).json({
        success: false,
        message: "Only Add permission can verify / approve this task",
      });
    }

    const task = await ClTask.getInstanceById(id);
    if (!task) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }
    if (!canAccessVerificationInstance(task, req)) {
      return res.status(403).json({ success: false, message: "You are not the verification person for this task" });
    }

    const isOpen = task.task_type === "open";
    const awaitingFills = isOpen ? getAwaitingOpenFills(task.form_responses) : [];
    const targetFillId = fill_id || (awaitingFills.length === 1 ? awaitingFills[0].id : null);
    const openFillVerify = isOpen && !!targetFillId && awaitingFills.some((f) => String(f.id) === String(targetFillId));
    const legacyAwaiting = task.status === "awaiting_verification";

    if (!openFillVerify && !legacyAwaiting) {
      return res.status(400).json({
        success: false,
        message:
          isOpen && awaitingFills.length > 1 && !fill_id
            ? "Select which fill to verify (fill_id required)"
            : "Task is not awaiting verification",
      });
    }

    if (action === "approve") {
      const wantRedTicket =
        create_red_ticket === true ||
        create_red_ticket === 1 ||
        String(create_red_ticket).toLowerCase() === "true";
      if (wantRedTicket) {
        return res.status(400).json({
          success: false,
          message: "Create as Red Ticket only works with Reject — Approve is not allowed",
        });
      }

      const scoringOn = task.verification_required !== false;
      const scoreNum = Number(score);
      if (scoringOn && (!scoreNum || scoreNum < 1 || scoreNum > 10)) {
        return res.status(400).json({ success: false, message: "Score must be between 1 and 10" });
      }

      if (openFillVerify) {
        const result = approveOpenFillInResponses(task.form_responses, targetFillId, {
          score: scoringOn ? scoreNum : null,
          verifierRemark: verifier_remark,
        });
        if (result.error) {
          return res.status(404).json({ success: false, message: result.error });
        }
        await ClTask.saveOpenFormResponses(id, { formResponses: result.formResponses });
        await logClTask(req, {
          action: "approve",
          entity_id: task.cl_task_id,
          record: { cl_task_id: task.cl_task_id, title: task.title, instance_id: Number(id) },
          details: {
            instance_id: Number(id),
            fill_id: targetFillId,
            score: scoringOn ? scoreNum : null,
            via: "add",
            open_fill: true,
          },
        });
        return res.json({
          success: true,
          message: "Fill verified — open task stays on Due for more fills",
          data: { fill_id: targetFillId },
        });
      }

      await ClTask.approveInstance(id, scoringOn ? scoreNum : null, verifier_remark);
      await logClTask(req, {
        action: "approve",
        entity_id: task.cl_task_id,
        record: { cl_task_id: task.cl_task_id, title: task.title, instance_id: Number(id) },
        details: {
          instance_id: Number(id),
          score: scoringOn ? scoreNum : null,
          via: "add",
        },
      });
      return res.json({
        success: true,
        message: "Task verified and completed",
      });
    }

    if (action === "reject") {
      const remark = String(verifier_remark || "").trim();
      if (!remark) {
        return res.status(400).json({ success: false, message: "Remark is required when rejecting" });
      }

      const wantRedTicket =
        create_red_ticket === true ||
        create_red_ticket === 1 ||
        String(create_red_ticket).toLowerCase() === "true";

      let redTicketId = null;
      if (wantRedTicket) {
        const scoreNum = Number(score);
        if (!scoreNum || scoreNum < 1 || scoreNum > 10) {
          return res.status(400).json({
            success: false,
            message: "Select a score (1–10) for the red ticket penalty when creating a red ticket",
          });
        }
        if (!task.person_id) {
          return res.status(400).json({ success: false, message: "Task has no assignee for red ticket" });
        }

        const personRemark = String(task.person_remark || "").trim();
        const descParts = [
          `CL Task reject: ${task.title || "Task"}`,
          remark ? `Verifier remark: ${remark}` : null,
          personRemark ? `User remark: ${personRemark}` : null,
          `Score / penalty: ${scoreNum}`,
        ].filter(Boolean);
        const description = descParts.join("\n");
        const ticketTitle = `CL Reject — ${String(task.title || "Task").slice(0, 100)}`;

        redTicketId = await RedTicket.create({
          title: ticketTitle,
          description,
          priority: "high",
          status: "open",
          created_by: req.user.id,
          department_id: task.department_id ?? null,
          designation_id: task.designation_id ?? null,
          person_id: task.person_id,
          score_penalty: scoreNum,
          cl_instance_id: Number(id),
          task_id: null,
          ticket_date: toYmd(task.scheduled_date) || getISTDateString(),
        });

        const row = await RedTicket.getById(redTicketId);
        const penalty = Number(row?.score_penalty) || scoreNum;
        if (penalty > 0 && row?.person_id) {
          await MisScore.deleteBySource("red_ticket", redTicketId);
          await MisScore.addEntry({
            user_id: row.person_id,
            score_delta: -penalty,
            source_type: "red_ticket",
            source_id: redTicketId,
            remark: row.title,
            ledger_date: row.ticket_date_fmt || row.ticket_date || getISTDateString(),
            created_by: req.user.id,
          });
        }
      }

      if (openFillVerify) {
        const result = rejectOpenFillInResponses(task.form_responses, targetFillId, remark);
        if (result.error) {
          return res.status(404).json({ success: false, message: result.error });
        }
        await ClTask.saveOpenFormResponses(id, {
          formResponses: result.formResponses,
          personRemark: result.pulledBack ? result.personRemark : undefined,
          verifierRemark: remark,
          rejectCount: result.pulledBack ? result.rejectCount : undefined,
          clearCycle: !!result.pulledBack,
        });
        await logClTask(req, {
          action: "reject",
          entity_id: task.cl_task_id,
          record: { cl_task_id: task.cl_task_id, title: task.title, instance_id: Number(id) },
          details: {
            instance_id: Number(id),
            fill_id: targetFillId,
            reject_count: result.rejectCount,
            pulled_back: result.pulledBack,
            create_red_ticket: wantRedTicket,
            red_ticket_id: redTicketId,
          },
        });
        return res.json({
          success: true,
          message: wantRedTicket
            ? "Fill rejected, red ticket created — open task still on Due"
            : result.pulledBack
              ? "Fill rejected — sent back on Due to refill"
              : "Fill rejected — open task still on Due",
          data: {
            fill_id: targetFillId,
            reject_count: result.rejectCount,
            red_ticket_id: redTicketId,
          },
        });
      }

      await ClTask.rejectInstance(id, remark);
      await logClTask(req, {
        action: "reject",
        entity_id: task.cl_task_id,
        record: { cl_task_id: task.cl_task_id, title: task.title, instance_id: Number(id) },
        details: {
          instance_id: Number(id),
          reject_count: (task.reject_count || 0) + 1,
          create_red_ticket: wantRedTicket,
          red_ticket_id: redTicketId,
        },
      });
      return res.json({
        success: true,
        message: wantRedTicket
          ? "Task rejected, red ticket created, and sent back for refill"
          : "Task rejected and sent back",
        data: {
          reject_count: (task.reject_count || 0) + 1,
          red_ticket_id: redTicketId,
        },
      });
    }

    return res.status(400).json({ success: false, message: "Action must be approve or reject" });
  } catch (err) {
    console.error("verifyClTask:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to verify task" });
  }
}

/**
 * Edit scoring / weightage + verifier remark.
 * - ADD: while awaiting (alongside verify flow)
 * - APPROVE (authorize): before and after completed (update only; cannot approve)
 * - EDIT alone: cannot update score (user data only via submission-update)
 */
export async function updateVerificationReview(req, res) {
  try {
    const id = idFromReq(req, "instance_id", "id");
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid instance id" });
    }

    const canAdd = await userHasModuleAction(req, "cl_task_verification", "can_add");
    const canAuthorize = await userHasModuleAction(req, "cl_task_verification", "can_authorize");
    const isSuper = isSuperAdminUser(req);

    if (!canAdd && !canAuthorize && !isSuper) {
      return res.status(403).json({
        success: false,
        message: "Edit permission cannot update score — only Add (before verify) or Approve (update)",
      });
    }

    const task = await ClTask.getInstanceById(id);
    if (!task) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }
    /** Super Admin can update any instance (including from report after complete). */
    if (!isSuper && !canAccessVerificationInstance(task, req)) {
      return res.status(403).json({ success: false, message: "You cannot edit this verification task" });
    }

    const isCompleted = task.status === "completed";

    /** Completed score edits: Super Admin or Approve only. */
    if (isCompleted && !canAuthorize && !isSuper) {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin (or Approve permission) can update score after completion",
      });
    }

    /** ADD may only touch score while awaiting (verify path). */
    if (!canAuthorize && !isSuper && canAdd) {
      if (task.status !== "awaiting_verification") {
        return res.status(403).json({
          success: false,
          message: "Add permission can only set score while awaiting verification",
        });
      }
    }

    const editDaysBlocked = assertWithinEditDays(req, task.created_at || task.submitted_at, "edit");
    if (editDaysBlocked) {
      return res.status(editDaysBlocked.status).json({ success: false, message: editDaysBlocked.message });
    }

    if (!["awaiting_verification", "completed", "pending"].includes(task.status)) {
      return res.status(400).json({ success: false, message: "Cannot update review for this status" });
    }

    const scoringOn = task.verification_required !== false;
    let score = req.body.score;
    if (score !== undefined && score !== null && score !== "") {
      const scoreNum = Number(score);
      if (scoringOn && (!scoreNum || scoreNum < 1 || scoreNum > 10)) {
        return res.status(400).json({ success: false, message: "Score must be between 1 and 10" });
      }
      score = scoringOn ? scoreNum : null;
    } else {
      score = undefined;
    }

    const verifierRemark =
      req.body.verifier_remark !== undefined ? req.body.verifier_remark : undefined;

    await ClTask.updateVerifierReview(id, {
      score,
      verifierRemark,
    });

    await logClTask(req, {
      action: "verification_edit",
      entity_id: task.cl_task_id,
      record: { cl_task_id: task.cl_task_id, title: task.title, instance_id: Number(id) },
      details: { instance_id: Number(id), score: score ?? null, status: task.status },
    });

    const after = await ClTask.getInstanceById(id);
    res.json({
      success: true,
      message: "Verification review updated",
      data: serializeInstanceRow(after),
    });
  } catch (err) {
    console.error("updateVerificationReview:", err.stack || err);
    res.status(500).json({ success: false, message: err.message || "Failed to update verification review" });
  }
}

export async function deleteClTaskInstance(req, res) {
  try {
    const id = idFromReq(req, "instance_id", "id");
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid instance id" });
    }

    const task = await ClTask.getInstanceById(id);
    if (!task) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }
    if (!canAccessVerificationInstance(task, req)) {
      return res.status(403).json({ success: false, message: "You cannot delete this task" });
    }

    await ClTask.deleteInstance(id);
    await logClTask(req, {
      action: "instance_delete",
      entity_id: task.cl_task_id,
      record: { cl_task_id: task.cl_task_id, title: task.title, instance_id: Number(id) },
      details: { instance_id: Number(id), status: task.status },
    });

    res.json({ success: true, message: "CL task instance deleted" });
  } catch (err) {
    console.error("deleteClTaskInstance:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to delete CL task instance" });
  }
}

export async function setClTaskActive(req, res) {
  try {
    const id = idFromReq(req, "cl_task_id", "id");
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid CL task id" });
    }

    const master = await ClTask.getMasterById(id);
    if (!master) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }

    const actor = actorFromReq(req);
    const currentlyApproved = isTruthyFlag(master.approved ?? master.is_active);
    const raw = req.body?.approved ?? req.body?.is_active;
    const nextApproved =
      raw === undefined || raw === null || raw === ""
        ? !currentlyApproved
        : isTruthyFlag(raw);

    await ClTask.setMasterActive(id, nextApproved, actor);

    if (nextApproved && !currentlyApproved) {
      try {
        const refreshed = await ClTask.getMasterById(id);
        await spawnOnActivate(refreshed || master);
      } catch (spawnErr) {
        console.error("setClTaskActive spawn:", spawnErr.stack || spawnErr);
      }
    }

    await logClTask(req, {
      action: nextApproved ? "activate" : "deactivate",
      entity_id: id,
      record: { cl_task_id: id, title: master.title, approved: nextApproved },
      details: { previous_active: currentlyApproved },
    });

    const after = await ClTask.getMasterById(id);

    res.json({
      success: true,
      message: nextApproved ? "CL Task Master activated" : "CL Task Master deactivated — new cycles stopped",
      data: {
        cl_task_id: id,
        approved: isTruthyFlag(after?.approved ?? after?.is_active),
        is_active: isTruthyFlag(after?.approved ?? after?.is_active),
        next_occurrence: serializeClDate(after?.next_occurrence),
        approved_by: after?.approved_by || after?.approved_by_name || null,
        approved_by_name: after?.approved_by_name || after?.approved_by || null,
        approved_at: after?.approved_at || null,
      },
    });
  } catch (err) {
    console.error("setClTaskActive:", err.stack || err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to update CL task status",
    });
  }
}

export async function deleteClTask(req, res) {
  try {
    const id = idFromReq(req, "cl_task_id", "id");
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid CL task id" });
    }
    const master = await ClTask.getMasterById(id);
    if (!master) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }

    const actor = actorFromReq(req);
    // Log to mst_activity_logs with name + snapshot — then permanent delete
    await logClTask(req, {
      action: "delete",
      entity_id: master.cl_task_id,
      record: masterDeleteSnapshot(master),
      details: { permanent: true },
    });

    const result = await ClTask.deleteMaster(master.cl_task_id);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }
    res.json({
      success: true,
      message: "CL task permanently deleted (activity log retained)",
      data: {
        cl_task_id: master.cl_task_id,
        deleted_by: actor.name,
        deleted_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("deleteClTask:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to delete CL task" });
  }
}
