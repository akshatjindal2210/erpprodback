import fs from "fs";
import fsp from "fs/promises";
import readline from "readline";

const LOG_TS_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;

function lineTimestamp(line) {
  const m = line.match(LOG_TS_RE);
  if (!m) return null;
  const ts = new Date(m[1].replace(" ", "T")).getTime();
  return Number.isNaN(ts) ? null : ts;
}

/** Drop log lines older than retentionDays. Lines without a timestamp are kept. */
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

  const input = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const output = fs.createWriteStream(tmpPath, { encoding: "utf8" });

  try {
    for await (const line of input) {
      const ts = lineTimestamp(line);
      if (ts == null || ts >= cutoff) {
        output.write(`${line}\n`);
        kept += 1;
      } else {
        removed += 1;
      }
    }

    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.on("error", reject);
    });

    if (removed > 0) {
      await fsp.rename(tmpPath, filePath);
    } else {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }

  return { file: filePath, kept, removed, skipped: false };
}
