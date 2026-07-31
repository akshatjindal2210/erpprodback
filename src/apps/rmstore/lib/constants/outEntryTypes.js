export const OUT_ENTRY_TYPE = {
  STORE_OUT: "store_out",
  JOB_CARD: "job_card",
  RM_REJECTION: "rm_rejection",
};

export function normalizeOutEntryType(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === OUT_ENTRY_TYPE.RM_REJECTION || v === "rm rejection") {
    return OUT_ENTRY_TYPE.RM_REJECTION;
  }
  if (v === OUT_ENTRY_TYPE.JOB_CARD || v === "job card") {
    return OUT_ENTRY_TYPE.JOB_CARD;
  }
  return OUT_ENTRY_TYPE.STORE_OUT;
}

export function getOutEntryTypeLabel(entryType) {
  if (normalizeOutEntryType(entryType) === OUT_ENTRY_TYPE.RM_REJECTION) {
    return "RM Rejection";
  }
  if (normalizeOutEntryType(entryType) === OUT_ENTRY_TYPE.JOB_CARD) {
    return "Job Card";
  }
  return "Store Out";
}

export function isRmRejectionOutEntry(entryType) {
  return normalizeOutEntryType(entryType) === OUT_ENTRY_TYPE.RM_REJECTION;
}

export function isJobCardOutEntry(entryType) {
  return normalizeOutEntryType(entryType) === OUT_ENTRY_TYPE.JOB_CARD;
}
