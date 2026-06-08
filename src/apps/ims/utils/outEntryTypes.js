export const OUT_ENTRY_TYPE = {
  FORWARDING_NOTE: "forwarding_note",
  INVENTORY_OUT: "inventory_out",
  PACKING_AREA: "packing_area",
  /** @deprecated use PACKING_AREA */
  LEGACY_OTHER: "other",
};

export function isOutEntryInventoryOut(entryType) {
  return entryType === OUT_ENTRY_TYPE.INVENTORY_OUT;
}

export function isOutEntryPackingArea(entryType) {
  return (
    entryType === OUT_ENTRY_TYPE.PACKING_AREA ||
    entryType === OUT_ENTRY_TYPE.LEGACY_OTHER ||
    entryType === "packing_area"
  );
}

export function isOutEntryNonForwarding(entryType) {
  return isOutEntryInventoryOut(entryType) || isOutEntryPackingArea(entryType);
}

export function isOutEntryAutoAuthorized(entryType) {
  return isOutEntryNonForwarding(entryType);
}

export function normalizeOutEntryType(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === OUT_ENTRY_TYPE.INVENTORY_OUT) return OUT_ENTRY_TYPE.INVENTORY_OUT;
  if (
    v === OUT_ENTRY_TYPE.PACKING_AREA ||
    v === OUT_ENTRY_TYPE.LEGACY_OTHER ||
    v === "packing_area"
  ) {
    return OUT_ENTRY_TYPE.PACKING_AREA;
  }
  return OUT_ENTRY_TYPE.FORWARDING_NOTE;
}

export function getOutEntryTypeLabel(entryType) {
  if (isOutEntryInventoryOut(entryType)) return "Inventory Out";
  if (isOutEntryPackingArea(entryType)) return "Packing Area";
  if (entryType === OUT_ENTRY_TYPE.FORWARDING_NOTE) return "Forwarding Note";
  return entryType ? String(entryType) : "";
}
