/**
 * CL Task Report period / day-header scores.
 * Per-task day_scores come from aggregation; these helpers compile
 * person day %, person period %, day headers, and overall Score %.
 */

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function toYmd(val) {
  if (val == null || val === "") return "";
  const s = String(val).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : "";
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
  let sum = 0;
  for (const ymd of cols) {
    const pct = Number(pctMap[ymd]) || 0;
    day_pct_by_date[ymd] = pct;
    sum += pct;
    day_pct_breakdown_by_date[ymd] = breakdown[ymd] || {
      result: 0,
      parts: [],
      expression: "0% (no task data that day)",
    };
  }
  const period_score_pct = cols.length ? round1(sum / cols.length) : 0;
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
};
