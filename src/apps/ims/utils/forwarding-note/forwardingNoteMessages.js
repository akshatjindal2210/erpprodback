/** User-facing lock messages for forwarding note API. */

export function buildForwardingLockMessage(record) {
  const lockBy = record?.out_entry_locked_by_name || "another user";
  const lockAt = record?.out_entry_locked_at
    ? new Date(record.out_entry_locked_at).toLocaleString("en-IN")
    : null;
  return lockAt
    ? `This forwarding note is locked for out entry by ${lockBy} since ${lockAt}.`
    : `This forwarding note is locked for out entry by ${lockBy}.`;
}
