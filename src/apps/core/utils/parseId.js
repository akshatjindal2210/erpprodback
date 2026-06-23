/** Parse a positive integer primary key from API / UI input; returns null if invalid. */
export function parsePositiveIntId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") {
    return parsePositiveIntId(value.id ?? value.pk ?? null);
  }
  const s = String(value).trim();
  if (!s || s === "-") return null;
  const n = parseInt(s, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
