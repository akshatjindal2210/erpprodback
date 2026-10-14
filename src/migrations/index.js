/**
 * Runs the auto jobs of the CURRENT app version only: `migrations/v<package.json version>/*.js` (`export default`).
 *   package.json 5.0.0 → migrations/v5.0.0/*.js
 * Older version folders stop running once the version is bumped. `.mjs` files never run here (manual, via initDB).
 * No DB tracking — each job must be safe to re-run. Turn off by commenting `runVersionMigrations()` in initDB.
 */
import { readdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { APP_VERSION } from "../config/app/appVersion.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export async function runVersionMigrations() {
  const ver = `v${APP_VERSION}`;
  let files = [];
  try {
    files = (await readdir(path.join(ROOT, ver))).filter((f) => f.endsWith(".js")).sort();
  } catch {
    return; // no folder for this version
  }

  for (const file of files) {
    try {
      const mod = await import(`./${ver}/${file}`);
      if (typeof mod.default === "function") await mod.default();
      console.log(`✅ [migration] ${ver}/${file}`);
    } catch (err) {
      console.warn(`[migration] ${ver}/${file}:`, err?.message || err);
    }
  }
}
