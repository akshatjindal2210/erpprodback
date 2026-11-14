/**
 * Drop redundant ims_tray_manage.tray_code — tray lives in data.links only.
 * Idempotent. Runs on v5.2.7 boot (5.2.6 already deployed).
 */
import dbQuery from "../../config/db/db.js";
import { IMS_TABLES as T } from "../../config/db/dbTables.js";
import { dropColumnIfExists } from "../../config/db/ensureDbColumns.js";

const TABLE = T.TRAY_MANAGE;

async function tableExists() {
  const rows = await dbQuery(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'ims_tray_manage' LIMIT 1`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

export default async function up() {
  if (!(await tableExists())) {
    console.log("[migration] trayManageDropTrayCode: table missing — skip");
    return;
  }
  await dropColumnIfExists(dbQuery, TABLE, "tray_code");
  console.log("[migration] trayManageDropTrayCode: tray_code dropped (or already gone)");
}
