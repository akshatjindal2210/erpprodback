import fs from "fs";
import fsp from "fs/promises";
import readline from "readline";

const LOG_TS_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;

/** POSIX rename overwrites; Windows throws EPERM/EEXIST if the dest exists. */
async function replaceFile(tmpPath, filePath) {
  try {
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    if (err.code !== "EPERM" && err.code !== "EEXIST") throw err;
    await fsp.copyFile(tmpPath, filePath);
    await fsp.unlink(tmpPath);
  }
}

function lineTimestamp(line) {
  const m = line.match(LOG_TS_RE);
  if (!m) return null;
  const ts = new Date(m[1].replace(" ", "T")).getTime();
  return Number.isNaN(ts) ? null : ts;
}

/** Drop log lines older than retentionDays. Untimestamped lines follow the previous entry. */
export async function enforceLogRetention(filePath, retentionDays = 30) {
  try {
    await fsp.access(filePath);
  } catch {
    return { file: filePath, kept: 0, removed: 0, skipped: true };
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const tmpPath = `${filePath}.retention-tmp`;
  let kept = 0;
  let removed = 0;
  let keepContinuation = false;

  const input = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const output = fs.createWriteStream(tmpPath, { encoding: "utf8" });

  try {
    for await (const line of input) {
      const ts = lineTimestamp(line);
      const keep = ts == null ? keepContinuation : ts >= cutoff;
      if (ts != null) keepContinuation = keep;

      if (keep) {
        output.write(`${line}\n`);
        kept += 1;
      } else {
        removed += 1;
      }
    }

    await new Promise((resolve, reject) => {
      output.on("error", reject);
      output.end(resolve);
    });

    if (removed > 0) {
      await replaceFile(tmpPath, filePath);
    } else {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }

  return { file: filePath, kept, removed, skipped: false };
}
