/**
 * CL Task scoring helpers.
 *
 * Verifier score is stored as 1–10 on the instance.
 * Reports display and compile scores as percentages, weighted by task weightage (1–10).
 *
 * See: docs/CL_TASK_SCORE.md
 */

/** Raw verifier score (1–10) → percentage 0–100. */
export function scoreToPercent(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((Math.min(10, Math.max(0, n)) / 10) * 1000) / 10; // 1 decimal
}

/** Contribution points = (score / 10) × weightage */
export function weightedPoints(score, weightage) {
  const s = Number(score);
  const w = Number(weightage);
  if (!Number.isFinite(s) || s <= 0) return 0;
  const ww = Number.isFinite(w) && w > 0 ? Math.min(10, Math.max(1, w)) : 1;
  return Math.round((s / 10) * ww * 100) / 100;
}

/**
 * User-level weighted percentage:
 *   Σ(score_i × weightage_i) / Σ(10 × weightage_i) × 100
 * Only tasks with a positive score contribute.
 */
export function weightedScorePercent(items = []) {
  let num = 0;
  let den = 0;
  for (const item of items) {
    const s = Number(item.score);
    if (!Number.isFinite(s) || s <= 0) continue;
    const w = Number(item.weightage);
    const ww = Number.isFinite(w) && w > 0 ? Math.min(10, Math.max(1, w)) : 1;
    num += s * ww;
    den += 10 * ww;
  }
  if (den <= 0) return 0;
  return Math.round((num / den) * 1000) / 10; // 1 decimal
}

/**
 * Final user % after MIS / red-ticket penalties (score_delta is usually negative):
 *   final_pct = clamp(task_pct + mis_delta, 0 … 100)
 */
export function finalScorePercent(taskPct, misDelta = 0) {
  const t = Number(taskPct);
  const m = Number(misDelta);
  const base = Number.isFinite(t) ? t : 0;
  const delta = Number.isFinite(m) ? m : 0;
  const raw = Math.round((base + delta) * 10) / 10;
  return Math.min(100, Math.max(0, raw));
}

/** Format for UI / export, e.g. "80%" */
export function formatScorePercent(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return "—";
  return `${n}%`;
}
