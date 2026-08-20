/**
 * Rasterize PDF pages in a child process so a bad PDF cannot kill the API.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const CHILD = fileURLToPath(new URL("./rasterizePdfPages.child.js", import.meta.url));
const TIMEOUT_MS = 90_000;

/**
 * @param {string} diskPath
 * @returns {Promise<string[]>} JPEG data URLs, one per page
 */
export function rasterizePdfPages(diskPath) {
  const outPath = path.join(os.tmpdir(), `cfr-pdf-${randomBytes(8).toString("hex")}.json`);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, diskPath, outPath], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    const err = [];
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.unlinkSync(outPath);
      } catch {
        /* ignore */
      }
      fn(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(reject, new Error("PDF rasterize timed out"));
    }, TIMEOUT_MS);

    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => {
      if (code !== 0) {
        const msg = Buffer.concat(err).toString("utf8").trim() || `PDF rasterize exit ${code}`;
        finish(reject, new Error(msg));
        return;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(outPath, "utf8") || "[]");
        finish(resolve, Array.isArray(parsed) ? parsed : []);
      } catch (e) {
        finish(reject, e);
      }
    });
  });
}
