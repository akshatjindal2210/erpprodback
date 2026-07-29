import ClTask from "../../cl-task/models/clTask.model.js";
import ReportReview from "../models/reportReview.model.js";
import MisScore from "../models/misScore.model.js";
import { getISTDateString, toYmd, isClTaskMissed } from "../../cl-task/helpers/time/clTaskTime.helper.js";
import { scoreToPercent, weightedPoints, weightedScorePercent, weightedScorePercentAll, finalScorePercent } from "../../cl-task/helpers/score/clTaskScore.helper.js";
import { getOpenFills, serializeOpenFillAsSubmission, normalizeToEntries } from "../../cl-task/helpers/form/clTaskForm.helper.js";
import { isSuperAdminReq } from "../../../../core/lib/utils/auth/permissionDays.js";
import { paramsFromReq, listLimit } from "../../../lib/shared/postRequest.js";
import User from "../../../../core/identity/users/models/user.model.js";
import { REPORT_DATE_YEAR_MIN, REPORT_DATE_YEAR_MAX, REPORT_DATE_RANGE_MAX_YEARS, REPORT_DATE_RANGE_MAX_DAYS } from "../reportDateRange.config.js";
import { compileUserPeriodScores, dayHeaderFromUserMaps, overallPeriodScorePct, REPORT_SCORE_FORMULAS } from "../helpers/reportScore.helper.js";

/**
 * CL Task Report visibility (same idea as assigned Task Report):
 * - super_admin / admin / EA → all (+ optional filters)
 * - user + manager designation (not executive) → own department team
 * - everyone else → own person only
 * Edit remains Super Admin–only (upsertReportReview + modal).
 */
async function resolveClReportScope(req, p = {}) {
  const role = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
  const userId = Number(req.user?.id) || 0;
  const canSeeAll =
    isSuperAdminReq(req) || role === "admin" || role === "executive_assistant";

  if (canSeeAll) {
    return {
      scope: "all",
      canSeeAll: true,
      department_id: p.department_id ? Number(p.department_id) : undefined,
      team_department_id: undefined,
      designation_id: p.designation_id ? Number(p.designation_id) : undefined,
      person_id: p.person_id ? Number(p.person_id) : undefined,
    };
  }

  if (!userId) {
    return { scope: "own", canSeeAll: false, person_id: null, unauthorized: true };
  }

  const isManager = await User.isManager(userId);
  const isExecutive = await User.isExecutive(userId);
  if (role === "user" && isManager && !isExecutive) {
    const me = await User.getById(userId);
    const deptId = Number(me?.department_id) || 0;
    if (!deptId) {
      return {
        scope: "own",
        canSeeAll: false,
        person_id: userId,
        department_id: undefined,
        team_department_id: undefined,
        designation_id: undefined,
      };
    }
    return {
      scope: "team",
      canSeeAll: false,
      department_id: undefined,
      team_department_id: deptId,
      designation_id: p.designation_id ? Number(p.designation_id) : undefined,
      person_id: p.person_id ? Number(p.person_id) : undefined,
    };
  }

  return {
    scope: "own",
    canSeeAll: false,
    person_id: userId,
    department_id: undefined,
    team_department_id: undefined,
    designation_id: undefined,
  };
}

async function assertCanViewClReportInstance(req, task) {
  const scope = await resolveClReportScope(req, {});
  if (scope.unauthorized) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  if (scope.canSeeAll) return { ok: true };
  const pid = Number(task?.person_id);
  const uid = Number(req.user?.id);
  if (pid === uid) return { ok: true };
  if (scope.scope === "team" && scope.team_department_id) {
    const assignee = await User.getById(pid);
    if (Number(assignee?.department_id) === Number(scope.team_department_id)) {
      return { ok: true };
    }
  }
  return { ok: false, status: 403, message: "You can only view your own tasks" };
}

/** Default: today −2 … +7. */
function defaultDateRange() {
  const from = new Date();
  from.setDate(from.getDate() - 2);
  const to = new Date();
  to.setDate(to.getDate() + 7);
  return { date_from: toYmd(from), date_to: toYmd(to) };
}

/** Inclusive YYYY-MM-DD list for calendar columns (capped via reportDateRange.config). */
function buildDateColumns(dateFrom, dateTo, maxDays = REPORT_DATE_RANGE_MAX_DAYS) {
  const from = toYmd(dateFrom);
  const to = toYmd(dateTo);
  if (!from || !to || from > to) return [];
  const cap = Math.max(1, Number(maxDays) || REPORT_DATE_RANGE_MAX_DAYS);
  const out = [];
  let cur = from;
  while (cur <= to && out.length < cap) {
    out.push(cur);
    const [y, m, d] = cur.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d, 12));
    next.setUTCDate(next.getUTCDate() + 1);
    cur = next.toISOString().slice(0, 10);
  }
  return out;
}

function isDoneVerified(instance, today) {
  if (instance.status === "completed") {
    if (instance.verification_required === false || instance.scoring_enabled === false) return true;
    return instance.score != null;
  }
  return false;
}

function isNotDone(instance, today) {
  if (instance.status === "completed" && isDoneVerified(instance, today)) return false;
  if (instance.status === "pending" || instance.status === "awaiting_verification") return true;
  const sched = toYmd(instance.scheduled_date);
  return sched && sched < today;
}

function effectiveScore(instance, review) {
  if (review?.score != null) return Number(review.score);
  if (instance.score != null) return Number(instance.score);
  return 0;
}

/**
 * Open-task compile: average score, −0.5 per reject, minimum 1.
 * Weightage is applied once per open task (not per attempt).
 */
function openCompileScore(fills = []) {
  const scored = fills.filter((f) => {
    if (!(Number(f.score) > 0)) return false;
    if (f.status === "awaiting_verification" || f.status === "rejected") return false;
    return true;
  });
  if (!scored.length) return null;
  let sumScore = 0;
  let sumReject = 0;
  for (const f of scored) {
    sumScore += Number(f.score);
    sumReject += Math.max(0, Number(f.reject_count) || 0);
  }
  const avg = sumScore / scored.length;
  const adjusted = Math.max(1, Math.round((avg - sumReject * 0.5) * 10) / 10);
  return { avg, adjusted, fill_count: scored.length, reject_total: sumReject };
}

function pushTaskToMaps(taskRow, dayMap, userMap) {
  const day = taskRow.scheduled_date;
  if (!day) return;
  if (!dayMap[day]) dayMap[day] = { date: day, tasks: [], day_score: 0, day_score_pct: 0 };
  dayMap[day].tasks.push(taskRow);
  const pid = Number(taskRow.person_id) || 0;
  if (!userMap.has(pid)) {
    userMap.set(pid, {
      person_id: pid,
      person_name: taskRow.person_name || "—",
      department_name: taskRow.department_name || "",
      designation_name: taskRow.designation_name || "",
      tasks: [],
    });
  }
  userMap.get(pid).tasks.push(taskRow);
}

/** One compile item per master task (open + frequently aggregated); legacy singles stay one each. */
function compileItemsFromTasks(tasks = []) {
  const byMaster = new Map();
  const items = [];
  for (const t of tasks) {
    const isAgg =
      t.is_open_fill || t.is_open_aggregated || t.is_frequent_aggregated;
    if (isAgg) {
      const key =
        t.cl_task_id != null
          ? `m:${t.cl_task_id}:${t.person_id}`
          : `i:${t.instance_id}`;
      if (!byMaster.has(key)) {
        byMaster.set(key, { weightage: t.weightage, fills: [] });
      }
      if (
        (t.is_open_aggregated || t.is_frequent_aggregated) &&
        Number(t.effective_score_raw) > 0
      ) {
        byMaster.get(key).compiled = Number(t.effective_score_raw);
      } else if (!t.is_open_aggregated && !t.is_frequent_aggregated) {
        byMaster.get(key).fills.push({
          score: t.effective_score_raw,
          reject_count: t.reject_count,
        });
      }
    } else if (Number(t.effective_score_raw) > 0) {
      items.push({ score: t.effective_score_raw, weightage: t.weightage });
    }
  }
  for (const g of byMaster.values()) {
    if (g.compiled != null) {
      items.push({ score: g.compiled, weightage: g.weightage });
      continue;
    }
    const c = openCompileScore(g.fills);
    if (c) items.push({ score: c.adjusted, weightage: g.weightage });
  }
  return items;
}

function addDayScore(acc, ymd, scorePct) {
  if (!ymd) return;
  if (!acc[ymd]) acc[ymd] = { sumPct: 0, count: 0 };
  acc[ymd].sumPct += Number(scorePct) || 0;
  acc[ymd].count += 1;
}

function finalizeDayScores(acc) {
  return Object.fromEntries(
    Object.entries(acc).map(([ymd, v]) => [
      ymd,
      Math.round((v.sumPct / Math.max(1, v.count)) * 10) / 10,
    ]),
  );
}

/**
 * Per-day report state for UI:
 * - missed   → assigned, fill window closed, not completed
 * - pending  → due today still open, OR action taken (awaiting verification)
 * - done     → scored / completed
 * - none     → no assignment that day (frontend uses for pre-start "0")
 */
function addDayState(acc, ymd, state) {
  if (!ymd || !state) return;
  const rank = { missed: 1, pending: 2, done: 3 };
  const prev = acc[ymd];
  if (!prev || (rank[state] || 0) >= (rank[prev] || 0)) {
    acc[ymd] = state;
  }
}

function finalizeDayStates(acc) {
  return { ...acc };
}

function trackLatestInstance(group, inst, review, day) {
  if (!inst?.instance_id) return;
  if (!group.latest_instance_id) {
    group.latest_instance_id = inst.instance_id;
    group.latest_day = day || null;
  }
  if (!day) return;
  if (!group.latest_day || day >= group.latest_day) {
    group.latest_instance_id = inst.instance_id;
    group.latest_day = day;
    if (review && !group.awaiting) {
      group.review = review;
      group.is_red_flag = review.is_red_flag === true;
      group.management_remark = review.management_remark ?? null;
    }
  }
}

/** Stable group key so same master task collapses to one report row. */
function masterGroupKey(pid, inst) {
  const masterId = Number(inst.cl_task_id) || 0;
  if (masterId) return `${pid}:m:${masterId}`;
  const title = String(inst.title || "").trim().toLowerCase();
  if (title) return `${pid}:t:${title}`;
  return `${pid}:i:${inst.instance_id}`;
}

function emptyMasterGroup(pid, inst, weightage) {
  return {
    person_id: pid,
    cl_task_id: Number(inst.cl_task_id) || null,
    title: inst.title,
    person_name: inst.person_name,
    department_name: inst.department_name,
    designation_name: inst.designation_name,
    weightage,
    task_type: inst.task_type || null,
    recurrence_type: inst.recurrence_type || null,
    dayScoreAcc: {},
    dayStateAcc: {},
    score_parts: [],
    attempt_count: 0,
    done_count: 0,
    not_done_count: 0,
    reject_total: 0,
    minDay: null,
    maxDay: null,
    awaiting: false,
    awaiting_day: null,
    awaiting_instance_id: null,
    latest_instance_id: null,
    latest_day: null,
    is_red_flag: false,
    management_remark: null,
    review: null,
    verification_required: inst.verification_required,
  };
}

/**
 * Fold one frequently instance into person + master group (one calendar row).
 * Each scheduled day keeps its own % in day_scores; compile uses openCompileScore.
 * Future days (after today) are not written as 0% — they stay blank until due.
 */
function absorbFrequentInstance(group, inst, review, today) {
  const day = toYmd(inst.scheduled_date);
  if (!day) return;

  const weightage = Number(inst.weightage ?? inst.wastage) || 1;
  if (group.weightage == null) group.weightage = weightage;
  group.title = inst.title || group.title;
  group.person_name = inst.person_name || group.person_name;
  group.department_name = inst.department_name || group.department_name;
  group.designation_name = inst.designation_name || group.designation_name;
  group.verification_required = inst.verification_required;
  group.task_type = inst.task_type || group.task_type;
  group.recurrence_type = inst.recurrence_type || group.recurrence_type;

  if (!group.minDay || day < group.minDay) group.minDay = day;
  if (!group.maxDay || day > group.maxDay) group.maxDay = day;

  /** Upcoming schedule — keep row span, do not score as missed 0%. */
  if (day > today) {
    trackLatestInstance(group, inst, review, day);
    return;
  }

  const doneVerified = isDoneVerified(inst, today);
  const notDone = isNotDone(inst, today);
  if (doneVerified) group.done_count += 1;
  if (notDone) group.not_done_count += 1;

  group.attempt_count += 1;

  if (inst.status === "pending") {
    /** Missed = fill window closed; otherwise still due (pending). */
    const missed = isClTaskMissed(inst);
    addDayScore(group.dayScoreAcc, day, 0);
    addDayState(group.dayStateAcc, day, missed ? "missed" : "pending");
    trackLatestInstance(group, inst, null, day);
    return;
  }

  if (inst.status === "awaiting_verification") {
    group.awaiting = true;
    group.awaiting_day = day;
    group.awaiting_instance_id = inst.instance_id;
    addDayScore(group.dayScoreAcc, day, 0);
    /** Action taken — submitted, waiting verification */
    addDayState(group.dayStateAcc, day, "pending");
    trackLatestInstance(group, inst, null, day);
    return;
  }

  const scoreRaw = effectiveScore(inst, review);
  const scorePct = scoreToPercent(scoreRaw);
  const rejectCount = Math.max(0, Number(inst.reject_count) || 0);
  group.reject_total += rejectCount;

  if (scoreRaw > 0) {
    group.score_parts.push({ score: scoreRaw, reject_count: rejectCount });
  }
  addDayScore(group.dayScoreAcc, day, scorePct);
  addDayState(
    group.dayStateAcc,
    day,
    scoreRaw > 0 || doneVerified ? "done" : "pending",
  );

  if (review?.is_red_flag) {
    group.is_red_flag = true;
    group.management_remark = review.management_remark ?? group.management_remark;
    group.review = review;
  }
  trackLatestInstance(group, inst, review, day);
}

/** Collect per-task raw scores (1–10) for one calendar day. Includes 0% pending. */
function compileItemsFromDayScores(tasks = [], ymd) {
  const items = [];
  for (const t of tasks) {
    const w = t.weightage;
    if (t.day_scores && typeof t.day_scores === "object" && ymd in t.day_scores) {
      const pct = Number(t.day_scores[ymd]);
      const safePct = Number.isFinite(pct) ? pct : 0;
      items.push({
        person_id: t.person_id,
        score: safePct / 10,
        weightage: w,
      });
      continue;
    }
    if (
      !t.is_open_aggregated &&
      !t.is_frequent_aggregated &&
      t.scheduled_date === ymd
    ) {
      const raw = Number(t.effective_score_raw);
      items.push({
        person_id: t.person_id,
        score: Number.isFinite(raw) && raw > 0 ? raw : 0,
        weightage: w,
      });
    }
  }
  return items;
}

/**
 * Day header % for Admin/all view:
 * 1) compile each user's tasks that day (0% unfilled still counts for that user)
 * 2) average those user % equally
 * So 1 user at 100% + 2 users at 0% → 33.3%, not task-weighted skew.
 */
function dayScorePercentByUsers(tasks = [], ymd) {
  const items = compileItemsFromDayScores(tasks, ymd);
  if (!items.length) return 0;

  const byPerson = new Map();
  for (const it of items) {
    const pid = Number(it.person_id) || 0;
    if (!byPerson.has(pid)) byPerson.set(pid, []);
    byPerson.get(pid).push(it);
  }

  const userPcts = [];
  for (const personItems of byPerson.values()) {
    userPcts.push(weightedScorePercentAll(personItems));
  }
  if (!userPcts.length) return 0;
  return Math.round((userPcts.reduce((a, b) => a + b, 0) / userPcts.length) * 10) / 10;
}

/**
 * Fold one open instance into a person + master group.
 * Supports archived fills on one row, or one DB instance per submit.
 */
function absorbOpenInstance(group, inst, review, today) {
  const weightage = Number(inst.weightage ?? inst.wastage) || 1;
  if (group.weightage == null) group.weightage = weightage;
  group.title = inst.title || group.title;
  group.person_name = inst.person_name || group.person_name;
  group.department_name = inst.department_name || group.department_name;
  group.designation_name = inst.designation_name || group.designation_name;
  group.verification_required = inst.verification_required;

  if (inst.instance_id && !group.latest_instance_id) {
    group.latest_instance_id = inst.instance_id;
  }

  const fills = getOpenFills(inst.form_responses);
  let absorbedFromFills = 0;

  for (const fill of fills) {
    if (fill.status === "awaiting_verification" || fill.status === "rejected") continue;
    const fillDay =
      toYmd(fill.completed_at) ||
      toYmd(fill.submitted_at) ||
      toYmd(fill.filled_at) ||
      toYmd(inst.scheduled_date);
    if (!fillDay) continue;
    const scoreRaw = Number(fill.score) > 0 ? Number(fill.score) : 0;
    const scorePct = scoreToPercent(scoreRaw);
    const rejectCount = Math.max(0, Number(fill.reject_count) || 0);
    group.reject_total += rejectCount;
    group.attempt_count += 1;
    absorbedFromFills += 1;
    if (scoreRaw > 0) {
      group.done_count += 1;
      group.score_parts.push({ score: scoreRaw, reject_count: rejectCount });
    }
    addDayScore(group.dayScoreAcc, fillDay, scorePct);
    addDayState(group.dayStateAcc, fillDay, scoreRaw > 0 ? "done" : "pending");
    if (!group.minDay || fillDay < group.minDay) group.minDay = fillDay;
    if (!group.maxDay || fillDay > group.maxDay) group.maxDay = fillDay;
  }

  if (absorbedFromFills) {
    if (inst.status === "awaiting_verification") {
      group.awaiting = true;
      group.awaiting_day = toYmd(inst.scheduled_date) || today;
      group.awaiting_instance_id = inst.instance_id;
      group.not_done_count += 1;
      addDayState(group.dayStateAcc, group.awaiting_day, "pending");
    }
    trackLatestInstance(
      group,
      inst,
      review,
      toYmd(inst.completed_at) || toYmd(inst.submitted_at) || toYmd(inst.scheduled_date),
    );
    return;
  }

  // One instance per open submit (no fills array)
  const day =
    toYmd(inst.completed_at) ||
    toYmd(inst.submitted_at) ||
    toYmd(inst.scheduled_date);
  if (!day) return;
  if (inst.status === "pending") return;

  if (inst.status === "awaiting_verification") {
    group.awaiting = true;
    group.awaiting_day = day;
    group.awaiting_instance_id = inst.instance_id;
    group.not_done_count += 1;
    group.attempt_count += 1;
    addDayScore(group.dayScoreAcc, day, 0);
    addDayState(group.dayStateAcc, day, "pending");
    if (!group.minDay || day < group.minDay) group.minDay = day;
    if (!group.maxDay || day > group.maxDay) group.maxDay = day;
    trackLatestInstance(group, inst, null, day);
    return;
  }

  const scoreRaw = effectiveScore(inst, review);
  const scorePct = scoreToPercent(scoreRaw);
  const rejectCount = Math.max(0, Number(inst.reject_count) || 0);
  group.reject_total += rejectCount;
  group.attempt_count += 1;
  if (isDoneVerified(inst, today) || scoreRaw > 0) group.done_count += 1;
  if (scoreRaw > 0) {
    group.score_parts.push({ score: scoreRaw, reject_count: rejectCount });
  }
  addDayScore(group.dayScoreAcc, day, scorePct);
  addDayState(group.dayStateAcc, day, scoreRaw > 0 || isDoneVerified(inst, today) ? "done" : "pending");
  if (!group.minDay || day < group.minDay) group.minDay = day;
  if (!group.maxDay || day > group.maxDay) group.maxDay = day;

  if (review?.is_red_flag) {
    group.is_red_flag = true;
    group.management_remark = review.management_remark ?? group.management_remark;
    group.review = review;
  }
  trackLatestInstance(group, inst, review, day);
}

export async function getDailyReport(req, res) {
  try {
    const today = getISTDateString();
    const defaults = defaultDateRange();
    const p = paramsFromReq(req);
    const date_from = toYmd(p.date_from || p.dateFrom) || defaults.date_from;
    const date_to = toYmd(p.date_to || p.dateTo) || defaults.date_to;
    if (!date_from || !date_to || date_from > date_to) {
      return res.status(400).json({
        success: false,
        message: "Invalid date range. Check the From and To dates.",
      });
    }
    {
      const fromYear = Number(String(date_from).slice(0, 4));
      const toYear = Number(String(date_to).slice(0, 4));
      if (
        !Number.isFinite(fromYear) ||
        !Number.isFinite(toYear) ||
        fromYear < REPORT_DATE_YEAR_MIN ||
        toYear > REPORT_DATE_YEAR_MAX ||
        fromYear > REPORT_DATE_YEAR_MAX ||
        toYear < REPORT_DATE_YEAR_MIN
      ) {
        return res.status(400).json({
          success: false,
          message: `Dates must be between the years ${REPORT_DATE_YEAR_MIN} and ${REPORT_DATE_YEAR_MAX}.`,
        });
      }
      const [fy, fm, fd] = date_from.split("-").map(Number);
      const [ty, tm, td] = date_to.split("-").map(Number);
      const span =
        Math.floor(
          (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000,
        ) + 1;
      if (span > REPORT_DATE_RANGE_MAX_DAYS) {
        return res.status(400).json({
          success: false,
          message: `The date range is too large. Please choose From and To dates within ${REPORT_DATE_RANGE_MAX_YEARS} years.`,
        });
      }
    }
    const search = p.search;
    const scopeInfo = await resolveClReportScope(req, p);
    if (scopeInfo.unauthorized) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (scopeInfo.scope === "own" && !scopeInfo.person_id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const {
      department_id,
      team_department_id,
      designation_id,
      person_id,
      scope,
    } = scopeInfo;

    const instances = await ClTask.getInstances({
      page: 1,
      limit: listLimit(p.limit, 50000, 50000),
      sortBy: "scheduled_date",
      order: "ASC",
      department_id,
      team_department_id,
      designation_id,
      person_id,
      date_from,
      date_to,
      search: search || undefined,
      /** Report uses explicit date range — do not also clamp by view_days. */
      view_days: undefined,
    });

    const date_columns = buildDateColumns(date_from, date_to);

    const instanceIds = instances.map((i) => i.instance_id);
    let reviews = [];
    try {
      reviews = await ReportReview.getByInstances(instanceIds);
    } catch (e) {
      console.error("getDailyReport reviews:", e.message || e);
    }
    const reviewMap = Object.fromEntries(reviews.map((r) => [r.cl_instance_id, r]));

    const userIds = [...new Set(instances.map((i) => i.person_id).filter(Boolean))];
    let misTotal = 0;
    let misByUser = new Map();
    try {
      misByUser = await MisScore.getCompiledByUser(userIds, date_from, date_to);
      misTotal = [...misByUser.values()].reduce((s, v) => s + (Number(v) || 0), 0);
    } catch (e) {
      console.error("getDailyReport mis:", e.message || e);
    }

    const dayMap = {};
    const userMap = new Map();
    const scoredForCompile = [];
    let doneCount = 0;
    let notDoneCount = 0;
    /** Open + frequently: one row per person + master task */
    const openGroups = new Map();
    const frequentGroups = new Map();

    for (const inst of instances) {
      const review = reviewMap[inst.instance_id] ?? null;
      const weightage = Number(inst.weightage ?? inst.wastage) || 1;
      const pid = Number(inst.person_id) || 0;
      const type = String(inst.task_type || "").toLowerCase();
      const isOpen = type === "open";

      if (isOpen) {
        const gKey = masterGroupKey(pid, inst);
        if (!openGroups.has(gKey)) {
          openGroups.set(gKey, emptyMasterGroup(pid, inst, weightage));
        }
        absorbOpenInstance(openGroups.get(gKey), inst, review, today);
        continue;
      }

      // Frequently (and other scheduled): collapse same master to one row
      const gKey = masterGroupKey(pid, inst);
      if (!frequentGroups.has(gKey)) {
        frequentGroups.set(gKey, emptyMasterGroup(pid, inst, weightage));
      }
      absorbFrequentInstance(frequentGroups.get(gKey), inst, review, today);
    }

    const pushAggregatedGroup = (group, { taskType, isOpenAgg, isFrequentAgg }) => {
      const compiled = openCompileScore(group.score_parts);
      if (compiled) {
        scoredForCompile.push({ score: compiled.adjusted, weightage: group.weightage });
      }

      if (group.attempt_count <= 0 && !group.awaiting) {
        /** Future-only schedule in range — still show the row (blank cells until due). */
        if (!group.minDay && !group.maxDay) return;
      }

      const scoreRaw = compiled?.adjusted ?? 0;
      const onTime =
        !group.awaiting &&
        (scoreRaw > 0 || group.verification_required === false);

      const scorePct = scoreToPercent(scoreRaw);
      const wPoints = weightedPoints(scoreRaw, group.weightage);
      const day_scores = finalizeDayScores(group.dayScoreAcc);
      const day_states = finalizeDayStates(group.dayStateAcc || {});
      const awaitingDay = group.awaiting_day || today;
      const start = group.minDay || awaitingDay;
      const end = group.maxDay || awaitingDay;
      const instanceId =
        (group.awaiting && group.awaiting_instance_id) ||
        group.latest_instance_id ||
        group.awaiting_instance_id;
      if (!instanceId) return;

      /** Count only due/past rows — not future-only placeholders. */
      if (group.attempt_count > 0 || group.awaiting) {
        if (onTime) doneCount += 1;
        else notDoneCount += 1;
      }

      pushTaskToMaps(
        {
          instance_id: instanceId,
          cl_task_id: group.cl_task_id,
          fill_id: null,
          fill_count: group.attempt_count,
          day_scores,
          day_states,
          title: group.title,
          person_id: group.person_id,
          person_name: group.person_name,
          department_name: group.department_name,
          designation_name: group.designation_name,
          task_type: taskType,
          recurrence_type: group.recurrence_type || null,
          status: group.awaiting
            ? "awaiting_verification"
            : scoreRaw > 0 || group.done_count > 0
              ? "completed"
              : "pending",
          score: scoreRaw || null,
          effective_score_raw: scoreRaw,
          effective_score: scorePct,
          score_pct: scorePct,
          weighted_points: wPoints,
          scheduled_date: group.awaiting ? awaitingDay : end,
          startDate: start,
          endDate: end,
          weightage: group.weightage ?? null,
          done_verified: onTime,
          not_done: !!group.awaiting || (group.not_done_count > 0 && scoreRaw <= 0),
          reject_count: group.reject_total,
          is_open_fill: false,
          is_open_aggregated: !!isOpenAgg,
          is_frequent_aggregated: !!isFrequentAgg,
          is_red_flag: group.is_red_flag === true,
          management_remark: group.management_remark ?? null,
          review: group.awaiting ? null : group.review,
        },
        dayMap,
        userMap,
      );
    };

    for (const group of openGroups.values()) {
      pushAggregatedGroup(group, {
        taskType: "open",
        isOpenAgg: true,
        isFrequentAgg: false,
      });
    }
    for (const group of frequentGroups.values()) {
      pushAggregatedGroup(group, {
        taskType: group.task_type || "frequently",
        isOpenAgg: false,
        isFrequentAgg: true,
      });
    }

    // Day totals — every date column; missing user that day = 0%
    for (const ymd of date_columns) {
      if (!dayMap[ymd]) {
        dayMap[ymd] = { date: ymd, tasks: [], day_score: 0, day_score_pct: 0 };
      }
    }
    const allUserTasks = [...userMap.values()].flatMap((u) => u.tasks);

    const compiledTaskScorePct = weightedScorePercent(scoredForCompile);

    /** Nested users → tasks; period / day % compiled for the full date_columns range. */
    const users = [...userMap.values()]
      .sort((a, b) =>
        String(a.person_name).localeCompare(String(b.person_name), undefined, { sensitivity: "base" }),
      )
      .map((u, idx) => {
        const items = compileItemsFromTasks(u.tasks);
        const weighted_score_pct = weightedScorePercent(items);
        const mis_score_total = Number(misByUser.get(Number(u.person_id))) || 0;
        const final_score_pct = finalScorePercent(weighted_score_pct, mis_score_total);
        const sortedTasks = [...(u.tasks || [])].sort((a, b) =>
          String(a.startDate).localeCompare(String(b.startDate))
          || String(a.title).localeCompare(String(b.title)),
        );
        const { day_pct_by_date, day_pct_breakdown_by_date, period_score_pct } =
          compileUserPeriodScores({ tasks: sortedTasks }, date_columns);
        return {
          sno: idx + 1,
          person_id: u.person_id,
          person_name: u.person_name,
          department_name: u.department_name,
          designation_name: u.designation_name,
          weighted_score_pct,
          mis_score_total,
          final_score_pct,
          /** Range Score % (average of day % over date_columns; empty day = 0). */
          period_score_pct,
          day_pct_by_date,
          /** Super Admin: raw task parts for each person-day %. */
          day_pct_breakdown_by_date,
          tasks: sortedTasks,
        };
      });

    const userDayMaps = users.map((u) => u.day_pct_by_date || {});
    for (const day of Object.values(dayMap)) {
      const items = compileItemsFromDayScores(allUserTasks, day.date);
      day.day_score = items.reduce((s, i) => s + weightedPoints(i.score, i.weightage), 0);
      /** All users average; no data / future = 0%. */
      day.day_score_pct = dayHeaderFromUserMaps(userDayMaps, day.date);
    }

    const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
    const periodScorePct = overallPeriodScorePct(users.map((u) => u.period_score_pct));
    const finalCompiledPct = finalScorePercent(compiledTaskScorePct, misTotal);

    res.json({
      success: true,
      data: {
        date_from,
        date_to,
        date_columns,
        scope,
        users,
        days,
        score_formulas: REPORT_SCORE_FORMULAS,
        summary: {
          total_tasks: allUserTasks.length,
          done_verified: doneCount,
          not_done: notDoneCount,
          compiled_task_score: compiledTaskScorePct,
          compiled_task_score_pct: compiledTaskScorePct,
          mis_score_total: misTotal,
          net_score: finalCompiledPct,
          final_score_pct: finalCompiledPct,
          /** Primary Score % card — period average over date_columns (all users). */
          period_score_pct: periodScorePct,
          total_users: users.length,
        },
      },
    });
  } catch (err) {
    console.error("getDailyReport:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function upsertReportReview(req, res) {
  try {
    /** Report score/review updates — Super Admin only. */
    if (!isSuperAdminReq(req)) {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin can update report reviews",
      });
    }

    const {
      cl_instance_id,
      task_id,
      report_date,
      score,
      management_remark,
      is_red_flag,
    } = req.body;

    if (!cl_instance_id && !task_id) {
      return res.status(400).json({ success: false, message: "cl_instance_id or task_id required" });
    }

    const instForDate = cl_instance_id ? await ClTask.getInstanceById(Number(cl_instance_id)) : null;
    if (cl_instance_id && !instForDate) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    const safeReportDate = toYmd(report_date) || toYmd(instForDate?.scheduled_date) || getISTDateString();

    const reviewId = await ReportReview.upsert({
      cl_instance_id: cl_instance_id ? Number(cl_instance_id) : null,
      task_id: task_id ? Number(task_id) : null,
      report_date: safeReportDate,
      score: score != null ? Number(score) : null,
      management_remark,
      is_red_flag: !!is_red_flag,
      reviewed_by: req.user.id,
    });

    if (cl_instance_id && score != null) {
      await ClTask.updateInstanceScore(Number(cl_instance_id), Number(score));
    }

    if (is_red_flag && cl_instance_id) {
      const inst = instForDate || (await ClTask.getInstanceById(Number(cl_instance_id)));
      if (inst?.person_id) {
        await MisScore.deleteBySource("report_review", reviewId);
        const penalty = -(Math.abs(Number(score)) || 5);
        await MisScore.addEntry({
          user_id: inst.person_id,
          score_delta: penalty,
          source_type: "report_review",
          source_id: reviewId,
          remark: management_remark || "Red flag on task report",
          ledger_date: safeReportDate,
          created_by: req.user.id,
        });
      }
    }

    res.json({ success: true, message: "Report review saved", data: { review_id: reviewId } });
  } catch (err) {
    console.error("upsertReportReview:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

/** Report click: load instance plus all related open submissions. */
export async function getReportInstance(req, res) {
  try {
    const p = paramsFromReq(req);
    const id = Number(p.instance_id || p.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "instance_id required" });
    }

    const task = await ClTask.getInstanceById(id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    const access = await assertCanViewClReportInstance(req, task);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    let submission_fills = [];
    const isOpen = String(task.task_type || "").toLowerCase() === "open";
    const openFills = isOpen ? getOpenFills(task.form_responses) : [];
    const requestedFillId = p.fill_id != null && p.fill_id !== "" ? String(p.fill_id) : null;

    if (openFills.length) {
      submission_fills = openFills
        .map((f) => serializeOpenFillAsSubmission(task, f))
        .filter(Boolean);
    }

    /** Open fills + frequently sibling instances (past form fills for Super Admin edit). */
    if (task.cl_task_id && task.person_id) {
      const siblings = await ClTask.getInstances({
        cl_task_id: Number(task.cl_task_id),
        person_id: Number(task.person_id),
        page: 1,
        limit: 200,
        sortBy: "scheduled_date",
        order: "ASC",
      });
      const fromInstances = (siblings || [])
        .filter((s) => Number(s.cl_task_id) === Number(task.cl_task_id))
        .filter((s) => Number(s.person_id) === Number(task.person_id))
        .filter((s) => String(s.status || "") !== "pending")
        .flatMap((s) => {
          const nested = getOpenFills(s.form_responses);
          if (nested.length) {
            return nested.map((f) => serializeOpenFillAsSubmission(s, f)).filter(Boolean);
          }
          return [
            {
              instance_id: s.instance_id,
              fill_id: null,
              cl_task_id: s.cl_task_id,
              title: s.title,
              task_type: s.task_type,
              recurrence_type: s.recurrence_type,
              status: s.status,
              score: s.score,
              weightage: s.weightage ?? s.wastage ?? null,
              reject_count: s.reject_count ?? 0,
              scheduled_date: s.scheduled_date,
              submitted_at: s.submitted_at,
              person_remark: s.person_remark,
              verifier_remark: s.verifier_remark,
              form_schema: s.form_schema,
              form_responses: s.form_responses,
              person_id: s.person_id,
              person_name: s.person_name,
              verification_user_name: s.verification_user_name,
            },
          ];
        });

      const seen = new Set(submission_fills.map((f) => `${f.instance_id}:${f.fill_id || ""}`));
      for (const row of fromInstances) {
        const key = `${row.instance_id}:${row.fill_id || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        submission_fills.push(row);
      }
    }

    submission_fills.sort((a, b) =>
      String(a.submitted_at || a.scheduled_date || "").localeCompare(
        String(b.submitted_at || b.scheduled_date || ""),
      ),
    );

    const sibling_fills = submission_fills.filter(
      (f) => Number(f.instance_id) !== Number(task.instance_id) || f.fill_id,
    );

    /**
     * Super Admin edits any fill: hydrate requested fill, else latest archived fill
     * when current entries are empty (open tasks archive into fills[]).
     */
    let payload = { ...task, fill_id: null };
    if (isOpen && openFills.length) {
      const currentEntries = normalizeToEntries(task.form_responses);
      const hasCurrent = currentEntries.some(
        (e) => e?.responses && Object.keys(e.responses).length > 0,
      );
      let activeFill = null;
      if (requestedFillId) {
        activeFill = openFills.find((f) => String(f.id) === requestedFillId) || null;
      } else if (!hasCurrent) {
        activeFill = [...openFills].sort((a, b) =>
          String(b.submitted_at || b.completed_at || b.filled_at || "").localeCompare(
            String(a.submitted_at || a.completed_at || a.filled_at || ""),
          ),
        )[0] || null;
      }
      if (activeFill) {
        const row = serializeOpenFillAsSubmission(task, activeFill);
        payload = {
          ...task,
          fill_id: activeFill.id || null,
          status: row.status || task.status,
          score: row.score,
          person_remark: row.person_remark,
          verifier_remark: row.verifier_remark,
          submitted_at: row.submitted_at,
          completed_at: row.completed_at,
          reject_count: row.reject_count,
          form_responses: row.form_responses,
        };
      }
    }

    res.json({
      success: true,
      data: {
        ...payload,
        fills: openFills,
        submission_fills,
        sibling_fills,
        fill_count: submission_fills.length || 1,
      },
    });
  } catch (err) {
    console.error("getReportInstance:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
