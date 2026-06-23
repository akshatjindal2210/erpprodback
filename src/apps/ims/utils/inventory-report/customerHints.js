/**
 * Customer code hints for packings — shared by inventory report, stock adjustment, box.
 */

import dbQuery from "../../../../config/db.js";

export async function findCustomerHintsForPackings(packingNumbers = []) {
  const list = [...new Set(packingNumbers.map((p) => String(p ?? "").trim()).filter(Boolean))];
  if (!list.length) return [];

  return dbQuery(
    `SELECT
       trim(x.pn::text) AS packing_number,
       COALESCE(
         NULLIF(trim(boxes.override_cust::text), ''),
         NULLIF(trim(sa_hint.acc_code::text), ''),
         NULLIF(trim(sa_hdr.acc_code::text), ''),
         NULLIF(trim(dp.acc_code::text), '')
       ) AS customer_code,
       sa_hdr.financial_year
     FROM unnest($1::text[]) AS x(pn)
     LEFT JOIN ims_dailyprod dp ON (
       trim(dp.doc_no::text) = trim(x.pn::text)
       OR (
         nullif(trim(dp.doc_no::text), '-') ~ '^[0-9]+$'
         AND nullif(trim(x.pn::text), '-') ~ '^[0-9]+$'
         AND trim(dp.doc_no::text)::numeric = trim(x.pn::text)::numeric
       )
     )
     LEFT JOIN LATERAL (
       SELECT MAX(NULLIF(trim(b.override_cust::text), '')) AS override_cust
       FROM ims_box_table b
       WHERE trim(b.packing_number::text) = trim(x.pn::text) AND b.is_deleted = false
     ) boxes ON true
     LEFT JOIN LATERAL (
       SELECT MAX(NULLIF(trim(sa.acc_code::text), '')) AS acc_code
       FROM ims_box_table b
       INNER JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
       WHERE trim(b.packing_number::text) = trim(x.pn::text) AND b.is_deleted = false
     ) sa_hint ON true
     LEFT JOIN LATERAL (
       SELECT MAX(sa.financial_year) AS financial_year, MAX(NULLIF(trim(sa.acc_code::text), '')) AS acc_code
       FROM ims_stock_adjustment sa
       WHERE trim(sa.packing_number::text) = trim(x.pn::text) AND sa.is_deleted = false
     ) sa_hdr ON true`,
    [list]
  );
}
