import dbQuery from "./db.js";
import { initImsDB } from "../../apps/ims/lib/config/db/initDB.js";
import { initTaskDB } from "../../apps/task/lib/config/db/initDB.js";
import { initCoreDB } from "../../apps/core/lib/config/db/initDB.js";
import { initDashboardDB } from "../../apps/dashboard/lib/config/db/initDB.js";
import { initRmStoreDB } from "../../apps/rmstore/lib/config/db/initDB.js";
import { initHrmsDB } from "../../apps/hrms/lib/config/db/initDB.js";
import { initPurchaseDB } from "../../apps/purchase/lib/config/db/initDB.js";
import { initProductionDB } from "../../apps/production/lib/config/db/initDB.js";
import { runVersionMigrations } from "../../migrations/index.js";
import { runStartupBackfills, backfillShortageGrpname } from "../../backfills/index.js";
import { syncSerialSequences } from "./syncSequences.js";

/** Boot: structure (tables) → one-shot migrations → sequences. */
export const initDB = async () => {
  try {
    await dbQuery("SELECT 1");
    console.log("✅ PostgreSQL Connected");

    // Structure only
    await initCoreDB();
    await initImsDB();
    await initTaskDB();
    await initRmStoreDB();
    await initHrmsDB();
    await initPurchaseDB();
    await initProductionDB();
    await initDashboardDB();

    // One-shot migrations.
    await runVersionMigrations();

    await syncSerialSequences();
    console.log("✅ All Tables Ready");

    await backfillShortageGrpname();  // v4.1.5 backfill Shortage.grpname from IMS.
    // await runStartupBackfills();
    // console.log("✅ Startup backfills finished");
  } catch (err) {
    console.error("❌ initDB Failed:", err.message);
    throw err;
  }
};
