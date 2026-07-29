export const OUT_ENTRY_TYPE = {
  STORE_OUT: "store_out",
  RM_REJECTION: "rm_rejection",
};

export function normalizeOutEntryType(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === OUT_ENTRY_TYPE.RM_REJECTION || v === "rm rejection") {
    return OUT_ENTRY_TYPE.RM_REJECTION;
  }
  return OUT_ENTRY_TYPE.STORE_OUT;
}

export function getOutEntryTypeLabel(entryType) {
  if (normalizeOutEntryType(entryType) === OUT_ENTRY_TYPE.RM_REJECTION) {
    return "RM Rejection";
  }
  return "Store Out";
}

export function isRmRejectionOutEntry(entryType) {
  return normalizeOutEntryType(entryType) === OUT_ENTRY_TYPE.RM_REJECTION;
}
