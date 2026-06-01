import dbQuery from "./db.js";
import { initImsDB } from "../apps/ims/config/initDB.js";
import { initTaskDB } from "../apps/task/config/initDB.js";
import { initCoreDB } from "../apps/core/config/initDB.js";

export const initDB = async () => {
  try {
    await dbQuery("SELECT 1");
    console.log("✅ PostgreSQL Connected");

    await initCoreDB();
    await initImsDB();
    await initTaskDB();

    console.log("✅ All Tables Ready");
  } catch (err) {
    console.error("❌ initDB Failed:", err.message);
    throw err;
  }
};
