/**
 * ERP stock report DB stock — one row per packing + doc_dt + job_card + item.
 * Customer names comma-joined (display only); stock not split by customer.
 */

import { sqlBoxInHand, sqlDocDtFromDailyprod, sqlDocDtText, sqlBoxCustomerNameReport, sqlDailyprodLateralForBox } from "../../../box/utils/inventory/boxInventorySql.js";

const PN = (alias) => `NULLIF(TRIM(${alias}.packing_number::text), '')`;
const TRIM_TXT = (expr) => `NULLIF(TRIM((${expr})::text), '')`;
const IN_HAND = sqlBoxInHand("b");

const BOX_ITEM_DCODE = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN sa.item_dcode::text END,
  dp.item_dcode::text,
  '—'
)`;

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

const BOX_JOB_CARD = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN ${TRIM_TXT("sa.job_card_no")} END,
  ${TRIM_TXT("dp.job_card_no")}
)`;

const BOX_CUSTOMER_NAME = sqlBoxCustomerNameReport("b", "sa", "dp");

/** One row per in-hand box — dedupe by packing + doc_dt + job_card + item happens in JS merge. */
export function sqlErpStockDbRows() {
  return `
    SELECT
      TRIM(${PN("b")}::text) AS packing_number,
      TRIM(${BOX_ITEM_DCODE}) AS item_dcode,
      TRIM(${BOX_ITEM_CODE}) AS item_code,
      NULLIF(TRIM(COALESCE(${BOX_ITEM_DESC}, '')), '') AS item_desc,
      ${BOX_DOC_DT} AS doc_dt,
      ${BOX_JOB_CARD} AS job_card_no,
      NULLIF(TRIM(${BOX_CUSTOMER_NAME}::text), '') AS customer_name,
      COALESCE(b.qty, 0)::bigint AS db_stock
    FROM ims_box_table b
    LEFT JOIN ims_stock_adjustment sa
      ON sa.adjustment_id = b.sa_id
     AND sa.is_deleted = false
     AND sa.approved = true
    ${sqlDailyprodLateralForBox("b", "sa", PN("b"))}
    WHERE b.is_deleted = false
      AND ${PN("b")} IS NOT NULL
      AND (${IN_HAND})
      AND COALESCE(b.qty, 0) > 0
      AND TRIM(COALESCE(${BOX_ITEM_DCODE}, '')) NOT IN ('', '—')`;
}
