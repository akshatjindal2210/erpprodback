/** prod_job_card — drop shortage_ids (link is ims_shortage.docno only). */
import dbQuery from "../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../config/db/dbTables.js";
import { dropColumnIfExists, dropIndexesIfExist } from "../../config/db/ensureDbColumns.js";

export default async function up() {
  await dropIndexesIfExist(dbQuery, ["prod_job_card_shortage_ids_idx"]);
  await dropColumnIfExists(dbQuery, T.JOB_CARD, "shortage_ids");
}
