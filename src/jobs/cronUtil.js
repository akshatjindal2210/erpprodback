import cron from "node-cron";

export const CRON_TZ = "Asia/Kolkata";

/** Calendar date YYYY-MM-DD in cron timezone (IST). */
export function getCronDateString() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CRON_TZ }).format(new Date());
}

/** Add calendar days to a YYYY-MM-DD string (UTC date math — timezone-safe for dates). */
export function addCalendarDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
  return dt.toISOString().slice(0, 10);
}

/** Add calendar months to a YYYY-MM-DD string. */
export function addCalendarMonthsYmd(ymd, months) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + (Number(months) || 0));
  return dt.toISOString().slice(0, 10);
}

/** Add calendar years to a YYYY-MM-DD string. */
export function addCalendarYearsYmd(ymd, years) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCFullYear(dt.getUTCFullYear() + (Number(years) || 0));
  return dt.toISOString().slice(0, 10);
}

/** Defer work so node-cron's heartbeat is not blocked by long async/sync jobs. */
export function deferCronWork(fn) {
  setImmediate(() => {
    void Promise.resolve()
      .then(fn)
      .catch((err) => {
        console.error("[cron]", err?.message || err);
      });
  });
}

/**
 * Schedule cron work that may run longer than the cron interval.
 * Returns immediately from the tick handler; uses a busy flag to skip overlap.
 * Missed ticks (blocked event loop) invoke onMissed when provided.
 */
export function scheduleDeferred(expression, work, { name, onMissed, noOverlap = true } = {}) {
  let busy = false;

  const task = cron.schedule(
    expression,
    () => {
      if (busy) return;
      busy = true;
      deferCronWork(async () => {
        try {
          await work({ reason: "scheduled" });
        } finally {
          busy = false;
        }
      });
    },
    { timezone: CRON_TZ, name, noOverlap },
  );

  task.on("execution:missed", () => {
    if (!onMissed) return;
    // Same busy lock as scheduled tick — avoid overlapping missed + in-flight work.
    if (busy) return;
    busy = true;
    deferCronWork(async () => {
      try {
        await onMissed({ reason: "missed" });
      } catch (err) {
        console.error(`[cron:${name || "task"}] missed catch-up failed:`, err?.message || err);
      } finally {
        busy = false;
      }
    });
  });

  return task;
}
