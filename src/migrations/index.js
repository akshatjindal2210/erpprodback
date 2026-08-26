/**
 * Runs every `vX.Y.Z/*.js` with `export default`.
 * No DB tracking — turn off by commenting `runVersionMigrations()` in initDB.
 * Delete a version folder anytime; missing folder = no-op. Restore from git if needed.
 */

import { readdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export async function runVersionMigrations() {
  let versions = [];
  try {
    versions = (await readdir(ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^v\d/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return;
  }

  for (const ver of versions) {
    let files = [];
    try {
      files = (await readdir(path.join(ROOT, ver))).filter((f) => f.endsWith(".js")).sort();
    } catch {
      continue;
    }

    for (const file of files) {
      const id = `${ver}/${file}`;
      try {
        const mod = await import(`./${ver}/${file}`);
        if (typeof mod.default === "function") await mod.default();
      } catch (err) {
        console.warn(`[migration] ${id}:`, err?.message || err);
      }
    }
  }
}
