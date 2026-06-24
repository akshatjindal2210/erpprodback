import path from "path";

/**
 * Log file retention — change DEFAULT_RETENTION_DAYS here, or set LOG_RETENTION_DAYS in .env.
 * Examples: 15 (two weeks), 30 (one month), 60 (two months).
 */
export const DEFAULT_RETENTION_DAYS = 3;

/** Daily cleanup time (IST). Override with LOG_CLEANUP_CRON in .env. */
export const DEFAULT_CLEANUP_CRON = "0 3 * * *";

export function getLogSettings() {
  const fromEnv = parseInt(process.env.LOG_RETENTION_DAYS, 10);

  return {
    dir: process.env.LOG_DIR
      ? path.resolve(process.env.LOG_DIR)
      : path.join(process.cwd(), "logs"),
    retentionDays:
      Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RETENTION_DAYS,
    cleanupCron: process.env.LOG_CLEANUP_CRON || DEFAULT_CLEANUP_CRON,
    cleanupEnabled: process.env.LOG_CLEANUP_ENABLED !== "false",
  };
}
