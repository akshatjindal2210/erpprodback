/**
 * Lightweight DB stock query for ERP stock report — fg sellable qty only (no locations/QC breakdown).
 * Groups by packing + doc_dt + job_card + item + customer (same reused-packing rule as inventory report).
 */

import { sqlBoxSellable, sqlDocDtFromDailyprod, sqlDocDtText, sqlBoxCustomerCodeReport } from "../../../box/utils/inventory/boxInventorySql.js";

const PN = (alias) => `NULLIF(TRIM(${alias}.packing_number::text), '')`;
const TRIM_TXT = (expr) => `NULLIF(TRIM((${expr})::text), '')`;
const SELLABLE = sqlBoxSellable("b");

/** SA boxes: meta from linked SA only (safe when packing number is reused across years). */
const BOX_ITEM_DCODE = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN sa.item_dcode::text END,
  dp.item_dcode::text,
  '—'
)`;

const BOX_CUSTOMER_CODE = sqlBoxCustomerCodeReport("b", "sa", "dp");

const BOX_DOC_DT = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN ${sqlDocDtText("sa.doc_dt")} END,
  ${sqlDocDtFromDailyprod("dp")}
)`;

const BOX_ITEM_CODE = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN ${TRIM_TXT("sa.item_code")} END,
  ${TRIM_TXT("dp.item_code")},
  ${BOX_ITEM_DCODE}
)`;

const BOX_ITEM_DESC = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN ${TRIM_TXT("sa.item_desc")} END,
  ${TRIM_TXT("dp.item_desc")}
)`;

const BOX_CUSTOMER_NAME = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN ${TRIM_TXT("sa.acc_name")} END,
  ${TRIM_TXT("dp.acc_name")}
)`;

const BOX_JOB_CARD = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN ${TRIM_TXT("sa.job_card_no")} END,
  ${TRIM_TXT("dp.job_card_no")}
)`;

/** Faster than full inventory report SQL — only fields needed for ERP comparison. */
export function sqlErpStockDbRows() {
  return `
    SELECT
      TRIM(${PN("b")}::text) AS packing_number,
      TRIM(${BOX_ITEM_DCODE}) AS item_dcode,
      TRIM(MAX(${BOX_ITEM_CODE})) AS item_code,
      NULLIF(TRIM(COALESCE(MAX(${BOX_ITEM_DESC}), '')), '') AS item_desc,
      ${BOX_DOC_DT} AS doc_dt,
      ${BOX_JOB_CARD} AS job_card_no,
      ${BOX_CUSTOMER_CODE} AS customer_code,
      NULLIF(TRIM(COALESCE(MAX(${BOX_CUSTOMER_NAME}), '')), '') AS customer_name,
      SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${SELLABLE}))::bigint AS db_stock
    FROM ims_box_table b
    LEFT JOIN ims_stock_adjustment sa
      ON sa.adjustment_id = b.sa_id
     AND sa.is_deleted = false
     AND sa.approved = true
    LEFT JOIN ims_dailyprod dp
      ON b.sa_id IS NULL
     AND trim(b.packing_number::text) = trim(dp.doc_no::text)
    WHERE b.is_deleted = false
      AND ${PN("b")} IS NOT NULL
    GROUP BY ${PN("b")}, ${BOX_DOC_DT}, ${BOX_JOB_CARD}, ${BOX_ITEM_DCODE}, ${BOX_CUSTOMER_CODE}
    HAVING SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${SELLABLE})) > 0
       AND TRIM(COALESCE(${BOX_ITEM_DCODE}, '')) NOT IN ('', '—')`;
}
