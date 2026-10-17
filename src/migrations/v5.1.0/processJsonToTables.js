/**
 * v5.1.0 AUTO migration — rmstore_master_production.prime_process / finish_process JSON → eng_item_process
 * (prime → type 1, finish → type 2 fg on the FG item itself).
 * Safe to re-run: a row's JSON is set to NULL once moved.
 *
 *  1. Prime  — one prime per PRIME item (IMS PrimItemdcode, else the item itself); FG copies of it are dropped.
 *  2. FG — each row's finish → the item's own fg row, on its prime item's prime.
 *  3. Nothing left → prime_process / finish_process columns are dropped.
 *
 * A row that fails (IMS down, deleted process / machine, no prime) keeps its JSON, is logged, and is retried next boot.
 */
import dbQuery from "../../config/db/db.js";
import { RMSTORE_TABLES as R } from "../../config/db/dbTables.js";
import { columnExists, dropColumnsIfExist } from "../../config/db/ensureDbColumns.js";
import { getImsMapsSafe, canonicalCode } from "../../apps/ims/lib/utils/erp-api/lookup/imsLookup.js";
import { PROCESS_TYPE, findPrimeIdsByItems, findPlans, savePrime, saveFg } from "../../apps/engineering/modules/item-process/models/itemProcess.model.js";

const TAG = "[v5.1.0 item process]";
const T = R.MASTER_PRODUCTION;

export default async function processJsonToTables() {
  if (!(await columnExists(dbQuery, T, "prime_process"))) return;

  const rows = await dbQuery(
    `SELECT production_id, item_dcode, item_code, prime_process, finish_process FROM ${T}
     WHERE is_deleted = false AND (prime_process IS NOT NULL OR finish_process IS NOT NULL) ORDER BY production_id`
  );
  if (rows.length) {
    const { itemMap } = await getImsMapsSafe();
    if (!itemMap?.size) return console.warn(`${TAG} IMS item master not available — retry on next boot.`);
    const primeItemOf = (dcode) => Number(itemMap.get(canonicalCode(dcode))?.primitemdcode) || Number(dcode);
    const clearJson = (col, id) => dbQuery(`UPDATE ${T} SET ${col} = NULL WHERE production_id = $1`, [id]);
    const fail = (r, what, err) => console.warn(`${TAG} ${r.item_code || r.item_dcode}: ${what} not moved — ${err.message || err}`);

    // 1. Prime — the prime item's own JSON first, else the first FG copy
    const sorted = [...rows].sort((a, b) => (primeItemOf(a.item_dcode) === Number(a.item_dcode) ? -1 : 0) - (primeItemOf(b.item_dcode) === Number(b.item_dcode) ? -1 : 0));
    for (const r of sorted.filter((x) => x.prime_process?.stages?.length)) {
      const primeItem = primeItemOf(r.item_dcode);
      try {
        if (!(await findPrimeIdsByItems([primeItem])).size) await savePrime({ item_dcode: primeItem, processJson: r.prime_process, user: "system" });
        await clearJson("prime_process", r.production_id);
      } catch (err) {
        fail(r, "prime", err);
      }
    }

    // 2. Finish
    for (const r of rows.filter((x) => x.finish_process?.stages?.length)) {
      try {
        if (!(await findPlans({ type: PROCESS_TYPE.FG, item_dcode: r.item_dcode })).length) {
          await saveFg({ item_dcode: Number(r.item_dcode), processJson: r.finish_process, user: "system" });
        }
        await clearJson("finish_process", r.production_id);
      } catch (err) {
        fail(r, "finish", err);
      }
    }
  }

  // 3. Drop the old columns once nothing is left in them
  const [{ pending }] = await dbQuery(`SELECT COUNT(*)::int AS pending FROM ${T} WHERE is_deleted = false AND (prime_process IS NOT NULL OR finish_process IS NOT NULL)`);
  if (pending) return console.warn(`${TAG} ${pending} row(s) still have process JSON — old columns kept.`);
  await dropColumnsIfExist(dbQuery, T, ["prime_process", "finish_process"]);
  console.log(`✅ ${TAG} prime_process / finish_process columns dropped from ${T}.`);
}
