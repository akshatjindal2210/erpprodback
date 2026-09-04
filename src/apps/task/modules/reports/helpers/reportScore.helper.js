/**
 * CL Task Report period / day-header scores.
 * Per-task day_scores come from aggregation; these helpers compile
 * person day %, person period %, day headers, and overall Score %.
 */

import { isClOccurrenceDay, parseRecurrenceArray } from "../../cl-task/helpers/recurrence/clTaskRecurrence.helper.js";
import { getISTDateString } from "../../cl-task/helpers/time/clTaskTime.helper.js";

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function toYmd(val) {
  if (val == null || val === "") return "";
  const s = String(val).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : "";
}

function isSundayYmd(ymd) {
  const day = toYmd(ymd);
  if (!day) return false;
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() === 0;
}

function userSkipsSundays(user) {
  const tasks = user?.tasks || [];
  const frequent = tasks.filter((t) => String(t.task_type || "").toLowerCase() === "frequently");
  if (!frequent.length) return false;
  return frequent.every((t) => !t.include_sunday);
}

function taskHasStoredDay(task, ymd) {
  const scores = task?.day_scores && typeof task.day_scores === "object" ? task.day_scores : {};
  const states = task?.day_states && typeof task.day_states === "object" ? task.day_states : {};
  return Boolean(toYmd(ymd) && (ymd in scores || ymd in states));
}

function isFrequentTaskOccurrenceDay(task, ymd) {
  if (String(task?.task_type || "").toLowerCase() !== "frequently") return false;
  return isClOccurrenceDay(
    task.recurrence_type || "daily",
    {
      recurrence_weekdays: parseRecurrenceArray(task.recurrence_weekdays),
      recurrence_month_dates: parseRecurrenceArray(task.recurrence_month_dates),
      recurrence_year_dates: parseRecurrenceArray(task.recurrence_year_dates),
    },
    ymd,
    { includeSunday: task.include_sunday === true },
  );
}

/** Count day in period average only when a due instance has stored score/state (not future). */
function userHasScheduledDay(user, ymd, pctMap = {}, today = "") {
  if (ymd in pctMap) return true;
  if (today && ymd > today) return false;
  for (const t of user?.tasks || []) {
    if (taskHasStoredDay(t, ymd)) return true;
  }
  return false;
}

/**
 * Person day % from that person's tasks (weightage-weighted).
 * Only days present on a task (day_scores / day_states) contribute;
 * missing score that day = 0%.
 *
 *   Person day % = Σ(task_pct × weightage) ÷ Σ(weightage)
 *
 * Also returns per-day parts so Super Admin can see the raw sum.
 */
export function buildUserDayScoreMap(user) {
  const byDay = {};
  const add = (ymd, pct, weightage, meta = {}) => {
    if (!ymd) return;
    const w = Number(weightage) > 0 ? Number(weightage) : 1;
    const safePct = Number.isFinite(Number(pct)) ? Number(pct) : 0;
    if (!(ymd in byDay)) byDay[ymd] = { num: 0, den: 0, parts: [] };
    byDay[ymd].num += safePct * w;
    byDay[ymd].den += w;
    byDay[ymd].parts.push({
      title: meta.title || "—",
      weightage: w,
      pct: safePct,
    });
  };

  for (const t of user?.tasks || []) {
    const w = Number(t.weightage) || 1;
    const scores = t.day_scores && typeof t.day_scores === "object" ? t.day_scores : {};
    const states = t.day_states && typeof t.day_states === "object" ? t.day_states : {};
    const ymds = new Set();
    for (const k of Object.keys(scores)) {
      const ymd = toYmd(k);
      if (ymd) ymds.add(ymd);
    }
    for (const k of Object.keys(states)) {
      const ymd = toYmd(k);
      if (ymd) ymds.add(ymd);
    }
    for (const ymd of ymds) {
      const pct = ymd in scores ? Number(scores[ymd]) || 0 : 0;
      add(ymd, pct, w, { title: t.title });
    }
  }

  const pctMap = {};
  const breakdown = {};
  for (const [ymd, v] of Object.entries(byDay)) {
    const result = v.den > 0 ? round1(v.num / v.den) : 0;
    pctMap[ymd] = result;
    const partsExpr = v.parts.map((p) => `${p.pct}×${p.weightage}`).join(" + ");
    const denExpr = v.parts.map((p) => p.weightage).join(" + ");
    breakdown[ymd] = {
      result,
      parts: v.parts,
      expression:
        v.parts.length > 0
          ? `(${partsExpr}) ÷ (${denExpr}) = ${result}%`
          : "0%",
    };
  }
  return { pctMap, breakdown };
}

/**
 * Fill every date column (missing = 0%).
 * @returns {{
 *   day_pct_by_date: Record<string, number>,
 *   day_pct_breakdown_by_date: Record<string, object>,
 *   period_score_pct: number,
 * }}
 */
export function compileUserPeriodScores(user, dateColumns = []) {
  const { pctMap, breakdown } = buildUserDayScoreMap(user);
  const day_pct_by_date = {};
  const day_pct_breakdown_by_date = {};
  const cols = (dateColumns || []).map(toYmd).filter(Boolean);
  const skipSun = userSkipsSundays(user);
  const today = getISTDateString();
  let sum = 0;
  let count = 0;
  for (const ymd of cols) {
    if (skipSun && isSundayYmd(ymd)) continue;
    if (!userHasScheduledDay(user, ymd, pctMap, today)) continue;
    const pct = Number(pctMap[ymd]) || 0;
    day_pct_by_date[ymd] = pct;
    sum += pct;
    count += 1;
    day_pct_breakdown_by_date[ymd] = breakdown[ymd] || {
      result: 0,
      parts: [],
      expression: "0% (no task scheduled this day)",
    };
  }
  const period_score_pct = count ? round1(sum / count) : 0;
  return { day_pct_by_date, day_pct_breakdown_by_date, period_score_pct };
}

/** Day header = average of ALL users that day (missing user = 0%). */
export function dayHeaderFromUserMaps(userDayMaps = [], ymd) {
  const day = toYmd(ymd);
  if (!day || !userDayMaps.length) return 0;
  let sum = 0;
  for (const map of userDayMaps) {
    sum += Number(map?.[day]) || 0;
  }
  return round1(sum / userDayMaps.length);
}

/** Score % card = average of person period %. */
export function overallPeriodScorePct(periodPcts = []) {
  const parts = periodPcts.filter((n) => n != null && Number.isFinite(Number(n))).map(Number);
  if (!parts.length) return 0;
  return round1(parts.reduce((a, b) => a + b, 0) / parts.length);
}

export const REPORT_SCORE_FORMULAS = {
  person_day:
    "Person day % = Σ(task day % × weightage) ÷ Σ(weightage) for that person's tasks on that day (missing score = 0)",
  day: "Day % = (sum of each user's person day %) ÷ (number of users)",
  person: "Person period % = (sum of person day % in From–To) ÷ (number of days)",
  overall: "Score % = (sum of person period %) ÷ (number of persons)",
  no_verify: "No-verify / scoring-off completed task = full credit 10/10 (100%). Verified task = (rating ÷ 10) × 100%.",
};
