import { runDbBackup } from "../src/jobs/system/dbBackup.js";

try {
  const results = await runDbBackup();
  results.forEach((r) => console.log("Backup OK:", r.file));
} catch (err) {
  console.error("Backup failed:", err.message);
  process.exit(1);
}
