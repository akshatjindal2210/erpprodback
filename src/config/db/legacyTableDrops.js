import dbQuery from "./db.js";

/** Idempotent drops for tables removed after schema unification (safe every boot). */
export async function runLegacyTableDrops() {
  await dbQuery(`DROP TABLE IF EXISTS rmstore_audit_locations`);
  await dbQuery(`DROP TABLE IF EXISTS rmstore_audit_master`);
  await dbQuery(`DROP TABLE IF EXISTS prod_shortage`);
  await dbQuery(`DROP TABLE IF EXISTS prod_job_card_process_log`);
}
