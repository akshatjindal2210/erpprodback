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
 * Production shifts — ONE place on the backend (keep frontend jobCard.config.js in sync).
 *
 *   SHIFTS_PER_DAY = 2 or 3  → board / calendar columns (S1…Sn)
 *   SHIFT_HOURS    = 8       → hours per shift (est. production time + board Qty · hours)
 *
 * Change only these two numbers.
 */
export const SHIFTS_PER_DAY = 3;
export const SHIFT_HOURS = 8;

/** Valid schedule_shift ids: 1…SHIFTS_PER_DAY */
export const SHIFT_IDS = Array.from({ length: SHIFTS_PER_DAY }, (_, i) => i + 1);

export function isValidShift(n) {
  return SHIFT_IDS.includes(Number(n));
}
