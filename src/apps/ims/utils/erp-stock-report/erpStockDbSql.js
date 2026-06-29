/**
 * Lightweight DB stock query for ERP stock report — fg sellable qty only (no locations/QC breakdown).
 */

import { sqlBoxSellable, sqlDocDtFromDailyprod, sqlDocDtText } from "../box/boxInventorySql.js";

const PN = (alias) => `NULLIF(TRIM(${alias}.packing_number::text), '')`;
const TRIM_TXT = (expr) => `NULLIF(TRIM((${expr})::text), '')`;
const SELLABLE = sqlBoxSellable("b");

const SA_META_CTE = `
  sa_meta AS (
    SELECT DISTINCT ON (packing_number)
      packing_number,
      item_dcode,
      ${TRIM_TXT("item_code")} AS item_code,
      ${TRIM_TXT("item_desc")} AS item_desc,
      ${sqlDocDtText("sa.doc_dt")} AS doc_dt
    FROM (
      SELECT
        ${PN("sa")} AS packing_number,
        sa.item_dcode,
        sa.item_code,
        sa.item_desc,
        sa.doc_dt,
        sa.approved_at
      FROM ims_stock_adjustment sa
      WHERE sa.is_deleted = false
        AND sa.approved = true
        AND sa.entry_type IN ('add', 'minus')
        AND ${PN("sa")} IS NOT NULL
    ) sa
    ORDER BY packing_number, approved_at DESC NULLS LAST
  )`;

const DP_META_CTE = `
  dp_meta AS (
    SELECT DISTINCT ON (packing_number)
      packing_number,
      item_dcode,
      ${TRIM_TXT("item_code")} AS item_code,
      ${TRIM_TXT("item_desc")} AS item_desc,
      ${sqlDocDtFromDailyprod("dp")} AS doc_dt
    FROM (
      SELECT
        NULLIF(TRIM(dp_inner.doc_no::text), '') AS packing_number,
        dp_inner.item_dcode,
        dp_inner.item_code,
        dp_inner.item_desc,
        dp_inner.doc_dt
      FROM ims_dailyprod dp_inner
      WHERE NULLIF(TRIM(dp_inner.doc_no::text), '') IS NOT NULL
    ) dp
    ORDER BY packing_number, (CASE WHEN dp.doc_dt IS NOT NULL THEN 0 ELSE 1 END), dp.doc_dt ASC NULLS LAST
  )`;

/** Faster than full inventory report SQL — only fields needed for ERP comparison. */
export function sqlErpStockDbRows() {
  return `
    WITH
    ${SA_META_CTE},
    ${DP_META_CTE},
    grouped AS (
      SELECT
        ${PN("b")} AS packing_number,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${SELLABLE}))::bigint AS db_stock
      FROM ims_box_table b
      WHERE b.is_deleted = false AND ${PN("b")} IS NOT NULL
      GROUP BY ${PN("b")}
      HAVING SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${SELLABLE})) > 0
    )
    SELECT
      TRIM(g.packing_number::text) AS packing_number,
      TRIM(COALESCE(sa.item_dcode::text, dp.item_dcode::text)) AS item_dcode,
      TRIM(COALESCE(sa.item_code, dp.item_code, sa.item_dcode::text, dp.item_dcode::text)) AS item_code,
      NULLIF(TRIM(COALESCE(sa.item_desc, dp.item_desc, '')), '') AS item_desc,
      COALESCE(sa.doc_dt, dp.doc_dt) AS doc_dt,
      COALESCE(g.db_stock, 0)::bigint AS db_stock
    FROM grouped g
    LEFT JOIN sa_meta sa ON sa.packing_number = g.packing_number
    LEFT JOIN dp_meta dp ON dp.packing_number = g.packing_number
    WHERE TRIM(COALESCE(g.packing_number::text, '')) NOT IN ('', '—')
      AND TRIM(COALESCE(sa.item_dcode::text, dp.item_dcode::text, '')) NOT IN ('', '—')`;
}
