/** v4.1.5 — backfill ims_shortage.grpname from IMS. Idempotent. */
import dbQuery from "../../config/db/db.js";
import { IMS_TABLES as T } from "../../config/db/dbTables.js";
import { canonicalCode, getImsMapsSafe } from "../../apps/ims/lib/utils/erp-api/lookup/imsLookup.js";

const EMPTY = `(grpname IS NULL OR BTRIM(grpname) = '')`;

export default async function backfillShortageGrpname() {
  if (process.env.BACKFILL_SHORTAGE_GRPNAME === "0") return;
  const { itemMap } = await getImsMapsSafe();
  if (!itemMap?.size) return;

  const rows = await dbQuery(
    `SELECT id, itemdcode FROM ${T.SHORTAGE} WHERE is_deleted = false AND ${EMPTY}`
  );
  if (!rows?.length) return;

  let n = 0;
  for (const row of rows) {
    const grpname = String(itemMap.get(canonicalCode(row.itemdcode))?.grpname ?? "").trim();
    if (!grpname) continue;
    n += (await dbQuery(
      `UPDATE ${T.SHORTAGE} SET grpname = $2, updated_at = NOW() WHERE id = $1 AND ${EMPTY}`,
      [row.id, grpname]
    ))?.rowCount || 0;
  }
  if (n > 0) console.log(`✅ [v4.1.5] Shortage grpname backfill: ${n} row(s)`);
}
