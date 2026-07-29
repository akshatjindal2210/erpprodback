import dbQuery from "./db.js";
import { initImsDB } from "../../apps/ims/lib/config/db/initDB.js";
import { initTaskDB } from "../../apps/task/lib/config/db/initDB.js";
import { initCoreDB } from "../../apps/core/lib/config/db/initDB.js";
import { initDashboardDB } from "../../apps/dashboard/lib/config/db/initDB.js";
// import { initRmStoreDB } from "../../apps/rmstore/lib/config/db/initDB.js";
import { runStartupBackfills } from "../../backfills/index.js";

export const initDB = async () => {
  try {
    await dbQuery("SELECT 1");
    console.log("✅ PostgreSQL Connected");

    await initCoreDB();
    await initImsDB();
    await initTaskDB();
    // await initRmStoreDB();
    await initDashboardDB();

    console.log("✅ All Tables Ready");

    await runStartupBackfills();
    console.log("✅ Startup backfills finished");
  } catch (err) {
    console.error("❌ initDB Failed:", err.message);
    throw err;
  }
};
