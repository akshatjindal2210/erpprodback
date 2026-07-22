import ClTask from "../models/clTask.model.js";
import ReportReview from "../models/reportReview.model.js";
import MisScore from "../models/misScore.model.js";
import { getISTDateString, toYmd } from "../helpers/clTaskTime.helper.js";
import { scoreToPercent, weightedPoints, weightedScorePercent, finalScorePercent } from "../helpers/clTaskScore.helper.js";
import { getOpenFills, serializeOpenFillAsSubmission } from "../helpers/clTaskForm.helper.js";
import { isSuperAdminReq } from "../../core/utils/permissionDays.js";
import { paramsFromReq, listLimit } from "../shared/postRequest.js";

/** Default: today −2 … +7. */
function defaultDateRange() {
  const from = new Date();
  from.setDate(from.getDate() - 2);
  const to = new Date();
  to.setDate(to.getDate() + 7);
  return { date_from: toYmd(from), date_to: toYmd(to) };
}

/** Inclusive YYYY-MM-DD list for calendar columns (no year cap). */
function buildDateColumns(dateFrom, dateTo) {
  const from = toYmd(dateFrom);
  const to = toYmd(dateTo);
  if (!from || !to || from > to) return [];
  const out = [];
  let cur = from;
  while (cur <= to) {
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

/** One compile item per open task; frequently tasks stay one item each. */
function compileItemsFromTasks(tasks = []) {
  const byOpen = new Map();
  const items = [];
  for (const t of tasks) {
    if (t.is_open_fill || t.is_open_aggregated) {
      const key = t.cl_task_id != null
        ? `m:${t.cl_task_id}:${t.person_id}`
        : `i:${t.instance_id}`;
      if (!byOpen.has(key)) {
        byOpen.set(key, { weightage: t.weightage, fills: [] });
      }
      if (t.is_open_aggregated && Number(t.effective_score_raw) > 0) {
        byOpen.get(key).compiled = Number(t.effective_score_raw);
      } else if (!t.is_open_aggregated) {
        byOpen.get(key).fills.push({
          score: t.effective_score_raw,
          reject_count: t.reject_count,
        });
      }
    } else if (Number(t.effective_score_raw) > 0) {
      items.push({ score: t.effective_score_raw, weightage: t.weightage });
    }
  }
  for (const g of byOpen.values()) {
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
    if (!group.minDay || fillDay < group.minDay) group.minDay = fillDay;
    if (!group.maxDay || fillDay > group.maxDay) group.maxDay = fillDay;
  }

  if (absorbedFromFills) {
    if (inst.status === "awaiting_verification") {
      group.awaiting = true;
      group.awaiting_day = toYmd(inst.scheduled_date) || today;
      group.awaiting_instance_id = inst.instance_id;
      group.not_done_count += 1;
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
    const search = p.search;
    /** Super admin + EA see all persons; others only own rows. */
    const role = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
    const canSeeAll = isSuperAdminReq(req) || role === "executive_assistant";

    /** Super admin / EA: all people + filters. Normal users: own tasks only. */
    let department_id;
    let designation_id;
    let person_id;
    if (canSeeAll) {
      department_id = p.department_id ? Number(p.department_id) : undefined;
      designation_id = p.designation_id ? Number(p.designation_id) : undefined;
      person_id = p.person_id ? Number(p.person_id) : undefined;
    } else {
      person_id = Number(req.user?.id);
      if (!person_id) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
    }

    const instances = await ClTask.getInstances({
      page: 1,
      limit: listLimit(p.limit, 50000, 50000),
      sortBy: "scheduled_date",
      order: "ASC",
      department_id,
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
    // Group open tasks by person + master task id
    const openGroups = new Map();

    for (const inst of instances) {
      const review = reviewMap[inst.instance_id] ?? null;
      const weightage = Number(inst.weightage ?? inst.wastage) || 1;
      const pid = Number(inst.person_id) || 0;
      const isOpen = String(inst.task_type || "").toLowerCase() === "open";

      if (isOpen) {
        const masterId = Number(inst.cl_task_id) || 0;
        const gKey = `${pid}:${masterId || inst.instance_id}`;
        if (!openGroups.has(gKey)) {
          openGroups.set(gKey, {
            person_id: pid,
            cl_task_id: masterId || null,
            title: inst.title,
            person_name: inst.person_name,
            department_name: inst.department_name,
            designation_name: inst.designation_name,
            weightage,
            dayScoreAcc: {},
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
          });
        }
        absorbOpenInstance(openGroups.get(gKey), inst, review, today);
        continue;
      }

      // Frequently: one calendar row per scheduled instance
      const day = toYmd(inst.scheduled_date);
      if (!day) continue;

      const doneVerified = isDoneVerified(inst, today);
      const notDone = isNotDone(inst, today);
      const scoreRaw = effectiveScore(inst, review);
      const scorePct = scoreToPercent(scoreRaw);
      const wPoints = weightedPoints(scoreRaw, weightage);

      if (doneVerified) doneCount += 1;
      if (notDone) notDoneCount += 1;

      if (scoreRaw > 0) {
        scoredForCompile.push({ score: scoreRaw, weightage });
      }

      pushTaskToMaps(
        {
          instance_id: inst.instance_id,
          cl_task_id: inst.cl_task_id || null,
          fill_id: null,
          title: inst.title,
          person_id: pid,
          person_name: inst.person_name,
          department_name: inst.department_name,
          designation_name: inst.designation_name,
          task_type: inst.task_type || null,
          recurrence_type: inst.recurrence_type || null,
          status: inst.status,
          score: inst.score,
          effective_score_raw: scoreRaw,
          effective_score: scorePct,
          score_pct: scorePct,
          weighted_points: wPoints,
          scheduled_date: day,
          startDate: day,
          endDate: day,
          weightage: inst.weightage ?? inst.wastage ?? null,
          done_verified: doneVerified,
          not_done: notDone,
          reject_count: Number(inst.reject_count) || 0,
          is_open_fill: false,
          is_red_flag: review?.is_red_flag === true,
          management_remark: review?.management_remark ?? null,
          review,
        },
        dayMap,
        userMap,
      );
    }

    for (const group of openGroups.values()) {
      doneCount += group.done_count;
      notDoneCount += group.not_done_count;

      const compiled = openCompileScore(group.score_parts);
      if (compiled) {
        scoredForCompile.push({ score: compiled.adjusted, weightage: group.weightage });
      }

      if (group.attempt_count <= 0 && !group.awaiting) continue;

      const scoreRaw = compiled?.adjusted ?? 0;
      const scorePct = scoreToPercent(scoreRaw);
      const wPoints = weightedPoints(scoreRaw, group.weightage);
      const day_scores = finalizeDayScores(group.dayScoreAcc);
      const awaitingDay = group.awaiting_day || today;
      const start = group.minDay || awaitingDay;
      const end = group.maxDay || awaitingDay;
      const instanceId =
        (group.awaiting && group.awaiting_instance_id) ||
        group.latest_instance_id ||
        group.awaiting_instance_id;
      if (!instanceId) continue;

      pushTaskToMaps(
        {
          instance_id: instanceId,
          cl_task_id: group.cl_task_id,
          fill_id: null,
          fill_count: group.attempt_count,
          day_scores,
          title: group.title,
          person_id: group.person_id,
          person_name: group.person_name,
          department_name: group.department_name,
          designation_name: group.designation_name,
          task_type: "open",
          recurrence_type: null,
          status: group.awaiting ? "awaiting_verification" : "completed",
          score: scoreRaw || null,
          effective_score_raw: scoreRaw,
          effective_score: scorePct,
          score_pct: scorePct,
          weighted_points: wPoints,
          scheduled_date: group.awaiting ? awaitingDay : end,
          startDate: start,
          endDate: end,
          weightage: group.weightage ?? null,
          done_verified:
            !group.awaiting &&
            (scoreRaw > 0 || group.verification_required === false),
          not_done: !!group.awaiting,
          reject_count: group.reject_total,
          is_open_fill: false,
          is_open_aggregated: true,
          is_red_flag: group.is_red_flag === true,
          management_remark: group.management_remark ?? null,
          review: group.awaiting ? null : group.review,
        },
        dayMap,
        userMap,
      );
    }

    // Day totals — open tasks count once after compile
    for (const day of Object.values(dayMap)) {
      const items = compileItemsFromTasks(day.tasks);
      day.day_score = items.reduce((s, i) => s + weightedPoints(i.score, i.weightage), 0);
      day.day_score_pct = weightedScorePercent(items);
    }

    const compiledTaskScorePct = weightedScorePercent(scoredForCompile);

    const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

    /** Nested users → tasks for Gantt (Super Admin: all; Regular: own only — already filtered). */
    const users = [...userMap.values()]
      .sort((a, b) =>
        String(a.person_name).localeCompare(String(b.person_name), undefined, { sensitivity: "base" }),
      )
      .map((u, idx) => {
        const items = compileItemsFromTasks(u.tasks);
        const weighted_score_pct = weightedScorePercent(items);
        const mis_score_total = Number(misByUser.get(Number(u.person_id))) || 0;
        /** Task % minus red-ticket / MIS penalties → final % */
        const final_score_pct = finalScorePercent(weighted_score_pct, mis_score_total);
        return {
          sno: idx + 1,
          person_id: u.person_id,
          person_name: u.person_name,
          department_name: u.department_name,
          designation_name: u.designation_name,
          weighted_score_pct,
          mis_score_total,
          final_score_pct,
          tasks: u.tasks.sort((a, b) =>
            String(a.startDate).localeCompare(String(b.startDate))
            || String(a.title).localeCompare(String(b.title)),
          ),
        };
      });

    const finalCompiledPct = finalScorePercent(compiledTaskScorePct, misTotal);

    res.json({
      success: true,
      data: {
        date_from,
        date_to,
        /** Full day columns for this range — frontend must use these (no client-side year cap). */
        date_columns,
        scope: canSeeAll ? "all" : "own",
        /**
         * Nested JSON for timeline UI:
         * users[].sno, person_*, weighted_score_pct, mis_score_total, final_score_pct, tasks[]…
         */
        users,
        days,
        summary: {
          total_tasks: instances.length,
          done_verified: doneCount,
          not_done: notDoneCount,
          /** Task-only weightage-weighted % */
          compiled_task_score: compiledTaskScorePct,
          compiled_task_score_pct: compiledTaskScorePct,
          /** Red ticket / MIS sum (usually negative) */
          mis_score_total: misTotal,
          /** Final % = task % + MIS (red tickets subtracted) */
          net_score: finalCompiledPct,
          final_score_pct: finalCompiledPct,
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

    const role = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
    const canSeeAll = isSuperAdminReq(req) || role === "executive_assistant";
    if (!canSeeAll && Number(task.person_id) !== Number(req.user?.id)) {
      return res.status(403).json({ success: false, message: "You can only view your own tasks" });
    }

    let submission_fills = [];
    const isOpen = String(task.task_type || "").toLowerCase() === "open";
    const openFills = isOpen ? getOpenFills(task.form_responses) : [];

    if (openFills.length) {
      submission_fills = openFills
        .map((f) => serializeOpenFillAsSubmission(task, f))
        .filter(Boolean);
    }

    if (isOpen && task.cl_task_id && task.person_id) {
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

    res.json({
      success: true,
      data: {
        ...task,
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
