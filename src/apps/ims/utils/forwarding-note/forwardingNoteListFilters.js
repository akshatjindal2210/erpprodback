/** Out-entry list filters for forwarding queries (lateral join alias `oe` on ims_out_entry). */
export function applyForwardingOutEntryListFilter(conditions, key, val) {
  if (key === "out_entry_complete") {
    if (val === true || val === "true") {
      conditions.push("oe.out_uid IS NOT NULL AND COALESCE(oe.scan_complete, false) = true");
    } else if (val === false || val === "false") {
      conditions.push("(oe.out_uid IS NULL OR COALESCE(oe.scan_complete, false) = false)");
    }
    return true;
  }

  /** Stay on Pending FN tab until store-out (out entry) is authorized — not when scan alone completes. */
  if (key === "out_entry_approved") {
    if (val === true || val === "true") {
      conditions.push("oe.out_uid IS NOT NULL AND COALESCE(oe.approved, false) = true");
    } else if (val === false || val === "false") {
      conditions.push("(oe.out_uid IS NULL OR COALESCE(oe.approved, false) = false)");
    }
    return true;
  }

  return false;
}
