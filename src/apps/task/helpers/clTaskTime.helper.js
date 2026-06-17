/** Returns current hour (0–23) in Asia/Kolkata. */
export function getISTHour() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

export function getISTDateString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Previous tasks can only be submitted before 11:00 AM IST. */
export function canSubmitPreviousTask() {
  return getISTHour() < 11;
}

export function getTaskDateCategory(scheduledDate) {
  const today = getISTDateString();
  const scheduled = String(scheduledDate).slice(0, 10);
  if (scheduled === today) return "today";
  if (scheduled < today) return "previous";
  return "future";
}
