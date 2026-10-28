/**
 * prod_job_card: pldt → jobcarddt; add jobcardno / jcseriescode / fyid / planqty.
 * Existing rows: new ERP keys stay NULL (jcseriescode defaults 30). No backfill.
 * Rollback: export `down`.
 */
import dbQuery from "../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../config/db/dbTables.js";
import { dropColumnIfExists, dropIndexesIfExist, ensureUniqueIndex, renameColumnIfExists } from "../../config/db/ensureDbColumns.js";

const TABLE = T.JC;

export default async function up() {
  await renameColumnIfExists(dbQuery, TABLE, "pldt", "jobcarddt");

  await dbQuery(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS jobcardno INTEGER`);
  await dbQuery(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS jcseriescode INTEGER NOT NULL DEFAULT 30`);
  await dbQuery(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS fyid INTEGER`);
  await dbQuery(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS planqty NUMERIC`);

  await dropIndexesIfExist(dbQuery, ["prod_job_card_pldt_shift_idx"]);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS prod_job_card_jobcarddt_shift_idx
     ON ${TABLE} (jobcarddt, schedule_shift) WHERE is_deleted = false`
  );

  await ensureUniqueIndex(
    dbQuery,
    TABLE,
    "prod_job_card_erp_no_uq",
    "jcseriescode, fyid, jobcardno",
    "jobcardno IS NOT NULL AND fyid IS NOT NULL"
  );
}

export async function down() {
  await dropIndexesIfExist(dbQuery, ["prod_job_card_erp_no_uq", "prod_job_card_jobcarddt_shift_idx"]);
  await dropColumnIfExists(dbQuery, TABLE, "planqty");
  await dropColumnIfExists(dbQuery, TABLE, "fyid");
  await dropColumnIfExists(dbQuery, TABLE, "jcseriescode");
  await dropColumnIfExists(dbQuery, TABLE, "jobcardno");
  await renameColumnIfExists(dbQuery, TABLE, "jobcarddt", "pldt");
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS prod_job_card_pldt_shift_idx
     ON ${TABLE} (pldt, schedule_shift) WHERE is_deleted = false`
  );
}
