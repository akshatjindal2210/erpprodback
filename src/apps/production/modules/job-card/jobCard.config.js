/**
 * Job Card No — the ONE place to change it.
 *   job_card_no = JC_PREFIX + docno padded to JC_PAD digits   e.g. "JC-" + 000001 → JC-000001
 *   JC_START    = first docno (set it after the last number of the old system so numbering continues)
 */
export const JC_PREFIX = "JC-";
export const JC_PAD = 6;
export const JC_START = 1;

/** docno 25 → "JC-000025" */
export const jobCardNo = (docno) => `${JC_PREFIX}${String(docno).padStart(JC_PAD, "0")}`;
