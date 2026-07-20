import ClTask from "../models/clTask.model.js";
import ReportReview from "../models/reportReview.model.js";
import MisScore from "../models/misScore.model.js";
import { getISTDateString, toYmd } from "../helpers/clTaskTime.helper.js";
import { scoreToPercent, weightedPoints, weightedScorePercent, finalScorePercent } from "../helpers/clTaskScore.helper.js";
import { getOpenFills } from "../helpers/clTaskForm.helper.js";
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
 * Open fills: average score, soft reject penalty (−0.5 per reject across fills), min 1.
 * One contribution per open instance (weightage once — not once per fill).
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

/** Build compile items: open fills collapse to 1 avg+penalty score per instance. */
function compileItemsFromTasks(tasks = []) {
  const byOpen = new Map();
  const items = [];
  for (const t of tasks) {
    if (t.is_open_fill) {
      const key = t.instance_id;
      if (!byOpen.has(key)) {
        byOpen.set(key, { weightage: t.weightage, fills: [] });
      }
      byOpen.get(key).fills.push({
        score: t.effective_score_raw,
        reject_count: t.reject_count,
      });
    } else if (Number(t.effective_score_raw) > 0) {
      items.push({ score: t.effective_score_raw, weightage: t.weightage });
    }
  }
  for (const g of byOpen.values()) {
    const c = openCompileScore(g.fills);
    if (c) items.push({ score: c.adjusted, weightage: g.weightage });
  }
  return items;
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

    for (const inst of instances) {
      const review = reviewMap[inst.instance_id] ?? null;
      const weightage = Number(inst.weightage ?? inst.wastage) || 1;
      const pid = Number(inst.person_id) || 0;
      const isOpen = inst.task_type === "open";
      const fills = isOpen ? getOpenFills(inst.form_responses) : [];

          if (isOpen && fills.length) {
        // Display: one calendar row per completed archived fill
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
          const wPoints = weightedPoints(scoreRaw, weightage);
          const rejectCount = Math.max(0, Number(fill.reject_count) || 0);

          if (scoreRaw > 0) doneCount += 1;

          pushTaskToMaps(
            {
              instance_id: inst.instance_id,
              fill_id: fill.id || null,
              title: inst.title,
              person_id: pid,
              person_name: inst.person_name,
              department_name: inst.department_name,
              designation_name: inst.designation_name,
              task_type: "open",
              recurrence_type: null,
              status: "completed",
              score: scoreRaw || null,
              effective_score_raw: scoreRaw,
              effective_score: scorePct,
              score_pct: scorePct,
              weighted_points: wPoints,
              scheduled_date: fillDay,
              startDate: fillDay,
              endDate: fillDay,
              weightage: inst.weightage ?? inst.wastage ?? null,
              done_verified: scoreRaw > 0 || inst.verification_required === false,
              not_done: false,
              reject_count: rejectCount,
              is_open_fill: true,
              is_red_flag: review?.is_red_flag === true,
              management_remark: review?.management_remark ?? null,
              review,
            },
            dayMap,
            userMap,
          );
        }

        // Compile once per open instance (avg score − soft reject penalty)
        const compiled = openCompileScore(fills);
        if (compiled) {
          scoredForCompile.push({ score: compiled.adjusted, weightage });
        }

        // Current cycle still waiting / empty due
        if (inst.status === "awaiting_verification") {
          notDoneCount += 1;
          const day = toYmd(inst.scheduled_date) || today;
          pushTaskToMaps(
            {
              instance_id: inst.instance_id,
              fill_id: null,
              title: inst.title,
              person_id: pid,
              person_name: inst.person_name,
              department_name: inst.department_name,
              designation_name: inst.designation_name,
              task_type: "open",
              recurrence_type: null,
              status: inst.status,
              score: null,
              effective_score_raw: 0,
              effective_score: 0,
              score_pct: 0,
              weighted_points: 0,
              scheduled_date: day,
              startDate: day,
              endDate: day,
              weightage: inst.weightage ?? inst.wastage ?? null,
              done_verified: false,
              not_done: true,
              reject_count: Number(inst.reject_count) || 0,
              is_open_fill: false,
              is_red_flag: false,
              management_remark: null,
              review: null,
            },
            dayMap,
            userMap,
          );
        }
        continue;
      }

      // Frequently / legacy open (no fills array yet) — one row per instance
      const day = toYmd(inst.scheduled_date);
      if (!day) continue;

      const doneVerified = isDoneVerified(inst, today);
      const notDone = isOpen
        ? inst.status === "awaiting_verification" ||
          (inst.status === "pending" && fills.length === 0)
        : isNotDone(inst, today);
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

    // Day % / points — open fills collapse to one score per instance
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

/** Full CL instance for report score click — own row for users; all for Super Admin / EA.
 *  Includes sibling_fills (same master + person) so Open/Frequently multi-fills are visible.
 */
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

    let sibling_fills = [];
    if (task.cl_task_id && task.person_id && String(task.task_type || "").toLowerCase() === "open") {
      const siblings = await ClTask.getInstances({
        cl_task_id: Number(task.cl_task_id),
        person_id: Number(task.person_id),
        page: 1,
        limit: 200,
        sortBy: "scheduled_date",
        order: "ASC",
      });
      sibling_fills = (siblings || [])
        .filter((s) => Number(s.cl_task_id) === Number(task.cl_task_id))
        .filter((s) => Number(s.person_id) === Number(task.person_id))
        .filter((s) => Number(s.instance_id) !== Number(task.instance_id))
        .filter((s) => String(s.status || "") !== "pending")
        .map((s) => ({
          instance_id: s.instance_id,
          cl_task_id: s.cl_task_id,
          title: s.title,
          task_type: s.task_type,
          recurrence_type: s.recurrence_type,
          status: s.status,
          score: s.score,
          weightage: s.weightage ?? s.wastage ?? null,
          scheduled_date: s.scheduled_date,
          submitted_at: s.submitted_at,
          person_remark: s.person_remark,
          verifier_remark: s.verifier_remark,
          form_schema: s.form_schema,
          form_responses: s.form_responses,
          person_id: s.person_id,
          person_name: s.person_name,
          verification_user_name: s.verification_user_name,
        }));
    }

    res.json({
      success: true,
      data: {
        ...task,
        sibling_fills,
        fill_count: 1 + sibling_fills.length,
      },
    });
  } catch (err) {
    console.error("getReportInstance:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
