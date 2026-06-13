import cron from "node-cron";

export const CRON_TZ = "Asia/Kolkata";

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
 */
export function scheduleDeferred(expression, work, { name, onMissed } = {}) {
  let busy = false;

  const task = cron.schedule(
    expression,
    () => {
      if (busy) return;
      busy = true;
      deferCronWork(async () => {
        try {
          await work();
        } finally {
          busy = false;
        }
      });
    },
    { timezone: CRON_TZ, name },
  );

  if (onMissed) {
    task.on("execution:missed", () => {
      deferCronWork(onMissed);
    });
  }

  return task;
}
