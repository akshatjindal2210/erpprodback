/**
 * Job Card No — the ONE place to change it.
 *   pjobcardno = formatPJobCardNo(type, jobcardno)   e.g. JC-14130 · 2C-14129 (ERP jobcardno)
 *   docno        = internal PK; JC_START = first docno when migrating old numbering
 */
export const JC_PREFIX = "JC-";
export const JC_PAD = 6;
export const JC_START = 1;

/**
 * prod_job_card.type — add more as needed; default is JC.
 *   jc = 0 | 2c = 1 | …
 */
export const JOB_CARD_TYPE = { JC: 0, TWO_C: 1 };
export const JOB_CARD_TYPE_KEY = {
  [JOB_CARD_TYPE.JC]: "jc",
  [JOB_CARD_TYPE.TWO_C]: "2c",
};
export const JOB_CARD_TYPE_DEFAULT = JOB_CARD_TYPE.JC;

/** ERP mjcnew pjobcardno — e.g. JC-14211, 2C-14129. */
export function formatPJobCardNo(type, jobcardno) {
  const n = Number(jobcardno);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (Number(type) === JOB_CARD_TYPE.TWO_C) return `2C-${n}`;
  return `JC-${n}`;
}

/**
 * Required Qty (KG) — Maintain Job Card + RM Store.
 *
 * Line by line:
 *   1) baseKg   = gweight × qty
 *   2) extraKg  = baseKg × (ISSUE_QTY_EXTRA_PCT / 100)
 *   3) required = baseKg + extraKg
 *
 * Example (10%):  0.0025 × 369010 = 922.525
 *                 extra = 922.525 × 0.10 = 92.253
 *                 required = 922.525 + 92.253 = 1014.778 KG
 *
 * Change only ISSUE_QTY_EXTRA_PCT to raise/lower (e.g. 10 → 12).
 */
export const ISSUE_QTY_EXTRA_PCT = 10;

export function issueQtyKg(gweight, qty) {
  // 1) gweight × qty
  const baseKg = Number(gweight) * Number(qty);
  if (!(baseKg > 0)) return null;

  // 2) % of base
  const extraKg = (baseKg * ISSUE_QTY_EXTRA_PCT) / 100;

  // 3) base + extra
  const requiredKg = baseKg + extraKg;

  return +requiredKg.toFixed(3);
}

/**
 * Multiple Job Card (multi_jc) — how est. time is shared across selected machines.
 *
 *   false = machine-wise (current): each machine runs full qty
 *           e.g. 2 machines → 2 separate setup/run/total/shifts (as now)
 *
 *   true  = half-half: divide setup / run / total / shifts by machine count
 *           e.g. 2 machines → each time ÷ 2
 *
 * Change only this value. Used in jobCardProductionTime.js.
 */
export const MULTI_JC_SPLIT_TIME = true;

/**
 * Production time only (keep frontend jobCard.config.js in sync).
 * Shift count / codes come from Settings → Shifts (getShiftsPerDay).
 *
 *   SHIFT_HOURS = 8  → hours per shift (est. production time)
 */
export const SHIFT_HOURS = 8;

/** Valid shift index: 1…shiftsPerDay (Settings). If max omitted, any n >= 1. */
export function isValidShift(n, shiftsPerDay) {
  const v = Number(n);
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) return false;
  if (shiftsPerDay == null || shiftsPerDay === "") return true;
  return v <= Math.max(1, Number(shiftsPerDay) || 1);
}
