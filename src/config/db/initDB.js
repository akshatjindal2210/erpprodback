import dbQuery from "./db.js";
import { initImsDB } from "../../apps/ims/lib/config/db/initDB.js";
import { initTaskDB } from "../../apps/task/lib/config/db/initDB.js";
import { initCoreDB } from "../../apps/core/lib/config/db/initDB.js";
import { initDashboardDB } from "../../apps/dashboard/lib/config/db/initDB.js";
import { initRmStoreDB } from "../../apps/rmstore/lib/config/db/initDB.js";
import { initHrmsDB } from "../../apps/hrms/lib/config/db/initDB.js";
import { initPurchaseDB } from "../../apps/purchase/lib/config/db/initDB.js";
import { initProductionDB } from "../../apps/production/lib/config/db/initDB.js";
import { initEngineeringDB } from "../../apps/engineering/lib/config/db/initDB.js";
import { runVersionMigrations } from "../../migrations/index.js";
import { createDocumentsTable } from "../../lib/documents/index.js";
import { runStartupBackfills, backfillIrErpToGate, backfillShortageGrpname, backfillDocFiles } from "../../backfills/index.js";
import { syncSerialSequences } from "./syncSequences.js";
import { runLegacyTableDrops } from "./legacyTableDrops.js";

/** Boot: structure (tables) → one-shot migrations → sequences. */
export const initDB = async () => {
  try {
    await dbQuery("SELECT 1");
    console.log("✅ PostgreSQL Connected");

    // 1. App tables
    await initCoreDB();
    await initImsDB();
    await initTaskDB();
    await initRmStoreDB();
    await initHrmsDB();
    await initPurchaseDB();
    await initProductionDB();
    await initEngineeringDB();
    await initDashboardDB();
    
    await runLegacyTableDrops();    // Drop legacy tables (if any)

    // 2. Global tables
    await createDocumentsTable(); // documents + module file columns (lib/documents/documents.config.js)

    // 3. Migrations — auto jobs of the current version (migrations/v<package.json version>/*.js)
    await runVersionMigrations();

    // 4. Sequences
    await syncSerialSequences();
    console.log("✅ All Tables Ready");

    // 5. Manual backfills (backfills/index.js) — uncomment one → restart once → check the log → comment again
    // await runStartupBackfills();     // old small IMS / core data fixes (safe to re-run)
    // await backfillIrErpToGate();     // ⚠ one-time ERP invreceiving → gate entry (overwrites empty-file gates)
    // await backfillShortageGrpname(); // v4.1.5 Shortage.grpname from IMS
    // await backfillDocFiles();        // v5.0.0 old file paths → documents (auto on 5.0.0 — only needed after a version bump)
  } catch (err) {
    console.error("❌ initDB Failed:", err.message);
    throw err;
  }
};
