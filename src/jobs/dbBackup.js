import { spawn } from "child_process";
import cron from "node-cron";
import fs from "fs";
import path from "path";

import config from "../config/config.js";
import logger from "../utils/logger.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Calendar-day snapshot in weekly/ — not tied to hourly 8–19; runs at midnight (00:00). */
const WEEKLY_SNAPSHOT_HOUR = 0;
let running = false;

const pad = (n) => String(n).padStart(2, "0");

const dateTimeStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

const formatSize = (bytes) => {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${Math.round((mb / 1024) * 100) / 100} GB` : `${Math.round(mb * 100) / 100} MB`;
};

const getBackupRoot = () => {
  const dir = config.dbBackup.dir;
  const root = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
  fs.mkdirSync(root, { recursive: true });
  return root;
};

const removeOldSlotFiles = (dir, prefix, keep) => {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name !== keep && name.startsWith(prefix) && name.endsWith(".dump")) {
      fs.unlinkSync(path.join(dir, name));
      logger.info(`DB backup: removed previous file — ${name}`);
    }
  }
};

const pgDump = (outFile, env) =>
  new Promise((resolve, reject) => {
    const { host, port, user, database } = config.db;
    const args = ["-h", host, "-p", String(port), "-U", user, "-d", database, "-F", "c", "-Z", "6", "-f", outFile];
    const child = spawn(config.dbBackup.pgDump, args, { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => { if (err.length < 65536) err += c; });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `pg_dump exited with code ${code}`)),
    );
  }
);

const runOneBackup = async ({ targetDir, replacePrefix, fileName, label }) => {
  const { password } = config.db;
  const outFile = path.join(targetDir, fileName);
  const tempFile = `${outFile}.tmp`;
  const env = { ...process.env, PGPASSWORD: password };
  if (config.dbBackup.ssl) env.PGSSLMODE = "require";

  fs.mkdirSync(targetDir, { recursive: true });

  logger.info(`DB backup started (${label}) — ${outFile}`);
  try {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    await pgDump(tempFile, env);
    fs.renameSync(tempFile, outFile);
    removeOldSlotFiles(targetDir, replacePrefix, fileName);
  } catch (e) {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    throw e;
  }
  logger.info(`DB backup completed (${label}, ${formatSize(fs.statSync(outFile).size)}) — ${outFile}`);
  return { file: outFile, label };
};

const buildPlans = (root, cronMode) => {
  const now = new Date();
  const db = config.db.database;
  const plans = [];

  if (config.dbBackup.weeklyEnabled) {
    const h = now.getHours();
    const weeklyDir = path.join(root, config.dbBackup.weeklyDir);

    // Weekly sirf cron + 00:00: kal ka poora din → Mon–Sun slot (max 7 files).
    // Manual (npm run backup) weekly nahi — warna beech din partial se purana slot overwrite ho jata.
    if (cronMode && h === WEEKLY_SNAPSHOT_HOUR) {
      const snapshotDay = new Date(now);
      snapshotDay.setDate(snapshotDay.getDate() - 1);
      const weekday = WEEKDAYS[snapshotDay.getDay()];
      const name = `${db}_${weekday}.dump`;
      plans.push({
        targetDir: weeklyDir,
        replacePrefix: `${db}_${weekday}`,
        fileName: name,
        label: `weekly/${name}`,
      });
    }

  }

  if (config.dbBackup.hourlyEnabled) {
    const h = now.getHours();
    const { hourlyStartHour: start, hourlyEndHour: end } = config.dbBackup;
    if (!cronMode || (h >= start && h <= end)) {
      const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const name = `${db}_${dateTimeStamp(now)}.dump`;
      plans.push({
        targetDir: path.join(root, config.dbBackup.hourlyDir),
        replacePrefix: `${db}_${day}_${pad(h)}-`,
        fileName: name,
        label: `hourly/${name}`,
      });
    } else {
      logger.info(`DB backup: hourly skipped (work hours ${pad(start)}:00–${pad(end)}:00)`);
    }
  }

  return plans;
};

export async function runDbBackup({ cronMode = false } = {}) {
  const { host, user, password, database } = config.db;
  if (!host || !user || !password || !database) {
    throw new Error("DB backup: DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME are required in .env");
  }

  const plans = buildPlans(getBackupRoot(), cronMode);
  if (!plans.length) {
    if (cronMode) return [];
    throw new Error(
      "DB backup: nothing to run (disable both types, or manual only runs hourly — weekly is cron at 00:00)",
    );
  }

  const settled = await Promise.allSettled(plans.map(runOneBackup));
  const ok = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = settled.filter((r) => r.status === "rejected");

  for (const f of failed) {
    logger.error(`DB backup failed: ${f.reason?.message || f.reason}`);
  }
  if (!ok.length) throw failed[0].reason;

  return ok;
}

export function startDbBackupCron() {
  if (!config.dbBackup.enabled) {
    logger.info("DB backup cron disabled (DB_BACKUP_ENABLED=false)");
    return;
  }
  const schedule = config.dbBackup.cron;
  if (!cron.validate(schedule)) {
    logger.error(`DB backup: invalid cron — ${schedule}`);
    return;
  }

  const runScheduledBackup = async (label) => {
    if (running) return;
    running = true;
    try {
      await runDbBackup({ cronMode: true });
    } catch (err) {
      logger.error(`DB backup failed (${label}): ${err.message}`);
    } finally {
      running = false;
    }
  };

  cron.schedule(schedule, () => runScheduledBackup("cron"));

  // Cron only fires on the hour (e.g. :00); run once when the server starts.
  void runScheduledBackup("startup");

  const { hourlyStartHour: s, hourlyEndHour: e, dir } = config.dbBackup;
  logger.info(
    `DB backup cron enabled (${schedule}) — ${dir} | weekly: ${config.dbBackup.weeklyEnabled} (7 slots Mon–Sun at 00:00) | hourly: ${config.dbBackup.hourlyEnabled} (${pad(s)}:00-${pad(e)}:00)`,
  );
}
