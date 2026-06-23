/**
 * Packing doc_dt hints — production: ims_dailyprod; stock adjustment: ims_stock_adjustment.
 */

import dbQuery from "../../../../config/db.js";
import { sqlDailyprodDocNoMatch, sqlDocDtFromDailyprod, sqlDocDtText } from "../box/boxInventorySql.js";

export async function findDocDateHintsForPackings(packingNumbers = []) {
  const list = [...new Set(packingNumbers.map((p) => String(p ?? "").trim()).filter(Boolean))];
  if (!list.length) return [];

  return dbQuery(
    `SELECT
       TRIM(x.pn::text) AS packing_number,
       COALESCE(sa_dp.doc_dt, ${sqlDocDtFromDailyprod("dp")}) AS doc_dt
     FROM unnest($1::text[]) AS x(pn)
     LEFT JOIN LATERAL (
       SELECT ${sqlDocDtText("sa.doc_dt")} AS doc_dt
       FROM ims_stock_adjustment sa
       WHERE sa.is_deleted = false
         AND sa.approved = true
         AND sa.entry_type IN ('add', 'minus')
         AND NULLIF(TRIM(sa.packing_number::text), '') = NULLIF(TRIM(x.pn::text), '')
         AND sa.doc_dt IS NOT NULL
       ORDER BY sa.approved_at DESC NULLS LAST
       LIMIT 1
     ) sa_dp ON true
     LEFT JOIN LATERAL (
       SELECT dp2.doc_dt
       FROM ims_dailyprod dp2
       WHERE ${sqlDailyprodDocNoMatch("dp2.doc_no", "x.pn")}
       ORDER BY
         (CASE WHEN dp2.doc_dt IS NOT NULL THEN 0 ELSE 1 END) ASC,
         dp2.doc_dt ASC NULLS LAST
       LIMIT 1
     ) dp ON true`,
    [list]
  );
}
