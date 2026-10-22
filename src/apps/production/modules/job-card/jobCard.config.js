/**
 * Job Card No — the ONE place to change it.
 *   pjobcardno = JC_PREFIX + docno padded to JC_PAD digits   e.g. "JC-" + 000001 → JC-000001
 *   JC_START   = first docno (set it after the last number of the old system so numbering continues)
 */
export const JC_PREFIX = "JC-";
export const JC_PAD = 6;
export const JC_START = 1;

/** docno 25 → "JC-000025" (stored as pjobcardno) */
export const jobCardNo = (docno) => `${JC_PREFIX}${String(docno).padStart(JC_PAD, "0")}`;

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
