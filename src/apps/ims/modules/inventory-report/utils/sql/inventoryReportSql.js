/**
 * Inventory Report SQL — single query.
 * Rows grouped by packing + doc date + job card + item + customer (reused packing numbers stay separate).
 */

import { sqlBoxSellable, sqlBoxOnQcHold, sqlBoxInHand, sqlBoxCountedAsOut, sqlDocDtFromDailyprod, sqlDocDtText, sqlBoxCustomerCodeReport } from "../../../box/utils/inventory/boxInventorySql.js";

const PN = (alias) => `NULLIF(TRIM(${alias}.packing_number::text), '')`;
const TRIM_TXT = (expr) => `NULLIF(TRIM((${expr})::text), '')`;
const LOC_LABEL = `NULLIF(TRIM(COALESCE(lm.location_no, CONCAT(lm.rack_no::text, UPPER(COALESCE(lm.shelf_no::text, ''))))), '')`;

const IN_HAND = sqlBoxInHand("b");
const SELLABLE = sqlBoxSellable("b");
const IN_STORE = `${SELLABLE} AND b.location_id IS NOT NULL`;
const QC_HOLD = `${sqlBoxOnQcHold("b")} AND ${IN_HAND}`;
const PACKING_AREA = `${SELLABLE} AND b.location_id IS NULL`;
const SHOW_LOC = `(${IN_STORE}) OR (${QC_HOLD})`;
// const STOCK_BOX = `(${IN_STORE}) OR (${PACKING_AREA}) OR (${QC_HOLD})`;          /** Boxes that contribute to report stock zones (in store + packing + QC hold). */
/** Boxes in Total Stock zones only (in store + packing area) — excludes QC hold. */
const STOCK_BOX = `(${IN_STORE}) OR (${PACKING_AREA})`;
const IS_OUT = sqlBoxCountedAsOut("b");

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
  ${TRIM_TXT("dp.item_desc")},
  '—'
)`;

const BOX_CUSTOMER_NAME = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN ${TRIM_TXT("sa.acc_name")} END,
  ${TRIM_TXT("dp.acc_name")},
  '—'
)`;

const BOX_JOB_CARD = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN ${TRIM_TXT("sa.job_card_no")} END,
  ${TRIM_TXT("dp.job_card_no")}
)`;

/** Builds CTEs: grouped (packing + doc_dt + job_card + item + customer) + report_rows */
export function buildInventoryReportSql() {
  const stockHaving = `SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${IN_STORE})) > 0
       OR SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${PACKING_AREA})) > 0
       OR SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${QC_HOLD})) > 0`;

  const groupedCte = `
    grouped AS (
      SELECT
        ${PN("b")} AS packing_number,
        ${BOX_DOC_DT} AS doc_dt,
        ${BOX_JOB_CARD} AS job_card_no,
        ${BOX_ITEM_DCODE} AS item_dcode,
        ${BOX_CUSTOMER_CODE} AS customer_code,
        MAX(${BOX_ITEM_CODE}) AS item_code,
        MAX(${BOX_ITEM_DESC}) AS item_desc,
        MAX(${BOX_CUSTOMER_NAME}) AS customer_name,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${SELLABLE}))::bigint AS fg_stock_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${IN_STORE}))::bigint AS in_store_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${PACKING_AREA}))::bigint AS packing_area_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${QC_HOLD}))::bigint AS qc_hold_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${IS_OUT}))::bigint AS out_qty,
        COUNT(*) FILTER (WHERE (${IN_STORE}))::int AS in_store_boxes,
        COUNT(*) FILTER (WHERE (${PACKING_AREA}))::int AS packing_area_boxes,
        COUNT(*) FILTER (WHERE (${STOCK_BOX}))::int AS stock_box_count,
        COALESCE(
          ARRAY_AGG(b.box_no_uid::text ORDER BY b.box_no_uid::text)
          FILTER (WHERE (${STOCK_BOX}) AND NULLIF(TRIM(b.box_no_uid::text), '') IS NOT NULL),
          ARRAY[]::text[]
        ) AS stock_box_nos,
        STRING_AGG(DISTINCT ${LOC_LABEL}, ', ') FILTER (WHERE (${SHOW_LOC})) AS location_details,
        COALESCE(ARRAY_AGG(DISTINCT b.location_id::text) FILTER (WHERE (${SHOW_LOC})), ARRAY[]::text[]) AS in_store_location_ids
      FROM ims_box_table b
      LEFT JOIN ims_stock_adjustment sa
        ON sa.adjustment_id = b.sa_id
       AND sa.is_deleted = false
       AND sa.approved = true
      LEFT JOIN ims_dailyprod dp
        ON b.sa_id IS NULL
       AND trim(b.packing_number::text) = trim(dp.doc_no::text)
      LEFT JOIN ims_location_master lm ON lm.location_id = b.location_id
      WHERE b.is_deleted = false AND ${PN("b")} IS NOT NULL
      GROUP BY ${PN("b")}, ${BOX_DOC_DT}, ${BOX_JOB_CARD}, ${BOX_ITEM_DCODE}, ${BOX_CUSTOMER_CODE}
      HAVING ${stockHaving}
    ),
    report_rows AS (
      SELECT
        g.packing_number,
        g.doc_dt,
        g.item_dcode,
        g.item_code,
        g.item_desc,
        g.customer_code,
        g.customer_name,
        g.job_card_no,
        g.fg_stock_qty,
        g.in_store_qty,
        g.packing_area_qty,
        g.qc_hold_qty,
        g.out_qty,
        g.in_store_boxes,
        g.packing_area_boxes,
        g.stock_box_count,
        g.stock_box_nos,
        g.location_details,
        g.in_store_location_ids
      FROM grouped g
    )`;

  return { values: [], groupedCte, groupWhere: "" };
}

function pageOrder(sortBy, sortCol, sortDir) {
  if (sortBy === "doc_dt") {
    return `f.doc_dt ${sortDir} NULLS LAST, NULLIF(regexp_replace(f.packing_number::text, '\\D', '', 'g'), '')::bigint DESC NULLS LAST, f.item_dcode ASC`;
  }
  if (sortBy === "packing_number") {
    return `NULLIF(regexp_replace(f.packing_number::text, '\\D', '', 'g'), '')::bigint ${sortDir} NULLS LAST, f.packing_number ${sortDir}, f.doc_dt DESC NULLS LAST, f.item_dcode ASC`;
  }
  const col = sortCol.includes(".") ? sortCol.replace(/^g\./, "f.") : `f.${sortCol}`;
  return `${col} ${sortDir} NULLS LAST, f.packing_number DESC, f.doc_dt DESC NULLS LAST`;
}

export function sqlPageSlice({ sortBy, sortCol, sortDir, limitIdx, offsetIdx }) {
  const order = pageOrder(sortBy, sortCol, sortDir);
  return `
    SELECT
      CONCAT(f.packing_number, ':', f.item_dcode, ':', COALESCE(f.customer_code, ''), ':', COALESCE(f.doc_dt, ''), ':', COALESCE(f.job_card_no, '')) AS id,
      f.packing_number,
      f.item_dcode,
      f.item_code,
      f.item_desc,
      f.customer_code,
      f.customer_name,
      COALESCE(f.location_details, '—') AS location_details,
      COALESCE(f.in_store_location_ids, ARRAY[]::text[]) AS in_store_location_ids,
      COALESCE(f.fg_stock_qty, 0)::bigint AS fg_stock_qty,
      COALESCE(f.in_store_qty, 0)::bigint AS in_store_qty,
      COALESCE(f.packing_area_qty, 0)::bigint AS packing_area_qty,
      COALESCE(f.qc_hold_qty, 0)::bigint AS qc_hold_qty,
      COALESCE(f.out_qty, 0)::bigint AS out_qty,
      COALESCE(f.in_store_boxes, 0)::int AS in_store_boxes,
      COALESCE(f.stock_box_count, 0)::int AS stock_box_count,
      COALESCE(f.stock_box_nos, ARRAY[]::text[]) AS stock_box_nos,
      f.doc_dt,
      f.job_card_no
    FROM filtered f
    ORDER BY ${order}
    LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
}
