/** Complete filter for forwarding list (query must join `oe` on ims_out_entry). */
export function applyForwardingOutEntryListFilter(conditions, key, val) {
  if (key !== "out_entry_complete") return false;
  if (val !== true && val !== "true") return true;
  conditions.push(
    "oe.out_uid IS NOT NULL AND COALESCE(oe.scan_complete, false) = true"
  );
  return true;
}
