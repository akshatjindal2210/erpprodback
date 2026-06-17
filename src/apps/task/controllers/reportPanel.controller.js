import ClTask from "../models/clTask.model.js";
import ReportReview from "../models/reportReview.model.js";
import MisScore from "../models/misScore.model.js";
import { getISTDateString } from "../helpers/clTaskTime.helper.js";

function defaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { date_from: fmt(from), date_to: fmt(to) };
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
  const sched = String(instance.scheduled_date ?? "").slice(0, 10);
  return sched && sched < today;
}

function effectiveScore(instance, review) {
  if (review?.score != null) return Number(review.score);
  if (instance.score != null) return Number(instance.score);
  return 0;
}

export async function getDailyReport(req, res) {
  try {
    const today = getISTDateString();
    const defaults = defaultDateRange();
    const {
      date_from = defaults.date_from,
      date_to = defaults.date_to,
      department_id,
      designation_id,
      person_id,
      search,
    } = req.query;

    const instances = await ClTask.getInstances({
      page: 1,
      limit: 500,
      sortBy: "scheduled_date",
      order: "ASC",
      department_id: department_id ? Number(department_id) : undefined,
      designation_id: designation_id ? Number(designation_id) : undefined,
      person_id: person_id ? Number(person_id) : undefined,
      date_from,
      date_to,
      search: search || undefined,
    });

    const instanceIds = instances.map((i) => i.instance_id);
    const reviews = await ReportReview.getByInstances(instanceIds);
    const reviewMap = Object.fromEntries(reviews.map((r) => [r.cl_instance_id, r]));

    const userIds = [...new Set(instances.map((i) => i.person_id).filter(Boolean))];
    const misTotal = await MisScore.getCompiledForUsers(userIds, date_from, date_to);

    const dayMap = {};
    let compiledTaskScore = 0;
    let doneCount = 0;
    let notDoneCount = 0;

    for (const inst of instances) {
      const day = String(inst.scheduled_date).slice(0, 10);
      if (!dayMap[day]) dayMap[day] = { date: day, tasks: [], day_score: 0 };

      const review = reviewMap[inst.instance_id] ?? null;
      const doneVerified = isDoneVerified(inst, today);
      const notDone = isNotDone(inst, today);
      const score = effectiveScore(inst, review);

      if (doneVerified) doneCount += 1;
      if (notDone) notDoneCount += 1;

      compiledTaskScore += score;
      dayMap[day].day_score += score;

      dayMap[day].tasks.push({
        instance_id: inst.instance_id,
        title: inst.title,
        person_id: inst.person_id,
        person_name: inst.person_name,
        department_name: inst.department_name,
        designation_name: inst.designation_name,
        status: inst.status,
        score: inst.score,
        effective_score: score,
        scheduled_date: day,
        done_verified: doneVerified,
        not_done: notDone,
        is_red_flag: review?.is_red_flag === true,
        management_remark: review?.management_remark ?? null,
        review,
      });
    }

    const days = Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));

    res.json({
      success: true,
      data: {
        date_from,
        date_to,
        days,
        summary: {
          total_tasks: instances.length,
          done_verified: doneCount,
          not_done: notDoneCount,
          compiled_task_score: compiledTaskScore,
          mis_score_total: misTotal,
          net_score: compiledTaskScore + misTotal,
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

    const reviewId = await ReportReview.upsert({
      cl_instance_id: cl_instance_id ? Number(cl_instance_id) : null,
      task_id: task_id ? Number(task_id) : null,
      report_date: report_date || getISTDateString(),
      score: score != null ? Number(score) : null,
      management_remark,
      is_red_flag: !!is_red_flag,
      reviewed_by: req.user.id,
    });

    if (cl_instance_id && score != null) {
      await ClTask.updateInstanceScore(Number(cl_instance_id), Number(score));
    }

    if (is_red_flag && cl_instance_id) {
      const inst = await ClTask.getInstanceById(Number(cl_instance_id));
      if (inst?.person_id) {
        await MisScore.deleteBySource("report_review", reviewId);
        const penalty = -(Math.abs(Number(score)) || 5);
        await MisScore.addEntry({
          user_id: inst.person_id,
          score_delta: penalty,
          source_type: "report_review",
          source_id: reviewId,
          remark: management_remark || "Red flag on task report",
          ledger_date: report_date || String(inst.scheduled_date).slice(0, 10),
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
