import cron from "node-cron";
import path from "path";

import logger from "../apps/core/utils/logger.js";
import { deferCronWork, scheduleDeferred } from "../jobs/cronUtil.js";
import { getLogSettings } from "./config.js";
import { getLogDir, LOG_FILES } from "./paths.js";
import { enforceLogRetention } from "./logRetention.js";

let running = false;

export async function runLogCleanup() {
  const { retentionDays } = getLogSettings();
  const dir = getLogDir();

  const results = await Promise.all(
    LOG_FILES.map((name) => enforceLogRetention(path.join(dir, name), retentionDays)),
  );

  const pruned = results.filter((r) => !r.skipped && r.removed > 0);
  if (pruned.length) {
    const summary = pruned
      .map((r) => `${path.basename(r.file)}: removed ${r.removed}, kept ${r.kept}`)
      .join("; ");
    logger.info(`Log cleanup (${retentionDays}d retention) — ${summary}`);
  }

  return results;
}

export function startLogCleanupCron() {
  const settings = getLogSettings();

  if (!settings.cleanupEnabled) {
    logger.info("Log cleanup disabled (LOG_CLEANUP_ENABLED=false)");
    return;
  }

  if (!cron.validate(settings.cleanupCron)) {
    logger.error(`Log cleanup: invalid cron — ${settings.cleanupCron}`);
    return;
  }

  const run = async (label) => {
    if (running) return;
    running = true;
    try {
      await runLogCleanup();
    } catch (err) {
      logger.error(`Log cleanup failed (${label}): ${err.message}`);
    } finally {
      running = false;
    }
  };

  scheduleDeferred(settings.cleanupCron, () => run("cron"), { name: "log-cleanup" });
  deferCronWork(() => run("startup"));

  logger.info(
    `Log cleanup enabled (${settings.cleanupCron}) — ${settings.dir} | keep last ${settings.retentionDays} day(s)`,
  );
}
