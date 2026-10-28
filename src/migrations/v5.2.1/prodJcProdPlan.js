/**
 * prod_job_card → prod_jc; prod_job_card_plan → prod_plan;
 * plan columns process_id → proccode, machine_id → maccode.
 * Idempotent — safe if re-run; remove this file (or bump version) after all envs migrated.
 */
import dbQuery from "../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../config/db/dbTables.js";
import { dropColumnIfExists, renameColumnIfExists, renameTableIfExists } from "../../config/db/ensureDbColumns.js";

export default async function up() {
  await renameTableIfExists(dbQuery, "prod_job_card", T.JC);
  await renameTableIfExists(dbQuery, "prod_job_card_plan", T.PLAN);
  await renameColumnIfExists(dbQuery, T.PLAN, "process_id", "proccode");
  await renameColumnIfExists(dbQuery, T.PLAN, "machine_id", "maccode");
  await dropColumnIfExists(dbQuery, T.PLAN, "updated_at");
}
