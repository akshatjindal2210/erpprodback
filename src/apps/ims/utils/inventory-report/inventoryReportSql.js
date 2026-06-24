/**
 * Inventory Report SQL — single query.
 * Boxes aggregate + SA/dailyprod meta (DB columns, hash join). Filters on frontend.
 */

import { sqlBoxSellable, sqlBoxOnQcHold, sqlBoxInHand, sqlBoxCountedAsOut, sqlDocDtFromDailyprod, sqlDocDtText } from "../box/boxInventorySql.js";

const PN = (alias) => `NULLIF(TRIM(${alias}.packing_number::text), '')`;
const TRIM_TXT = (expr) => `NULLIF(TRIM((${expr})::text), '')`;
const LOC_LABEL = `NULLIF(TRIM(COALESCE(lm.location_no, CONCAT(lm.rack_no::text, UPPER(COALESCE(lm.shelf_no::text, ''))))), '')`;

const IN_HAND = sqlBoxInHand("b");
const SELLABLE = sqlBoxSellable("b");
const IN_STORE = `${SELLABLE} AND b.location_id IS NOT NULL`;
const QC_HOLD = `${sqlBoxOnQcHold("b")} AND ${IN_HAND}`;
const PACKING_AREA = `${SELLABLE} AND b.location_id IS NULL`;
const SHOW_LOC = `(${IN_STORE}) OR (${QC_HOLD})`;
const IS_OUT = sqlBoxCountedAsOut("b");

/** One approved SA row per packing (full table scan once). */
const SA_META_CTE = `
  sa_meta AS (
    SELECT DISTINCT ON (packing_number)
      packing_number,
      item_dcode,
      ${TRIM_TXT("item_code")} AS item_code,
      ${TRIM_TXT("item_desc")} AS item_desc,
      acc_code,
      ${TRIM_TXT("acc_name")} AS acc_name,
      ${sqlDocDtText("sa.doc_dt")} AS doc_dt
    FROM (
      SELECT
        ${PN("sa")} AS packing_number,
        sa.item_dcode,
        sa.item_code,
        sa.item_desc,
        sa.acc_code,
        sa.acc_name,
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

/** One dailyprod row per doc_no (full table scan once). */
const DP_META_CTE = `
  dp_meta AS (
    SELECT DISTINCT ON (packing_number)
      packing_number,
      item_dcode,
      ${TRIM_TXT("item_code")} AS item_code,
      ${TRIM_TXT("item_desc")} AS item_desc,
      acc_code,
      ${TRIM_TXT("acc_name")} AS acc_name,
      ${sqlDocDtFromDailyprod("dp")} AS doc_dt
    FROM (
      SELECT
        NULLIF(TRIM(dp_inner.doc_no::text), '') AS packing_number,
        dp_inner.item_dcode,
        dp_inner.item_code,
        dp_inner.item_desc,
        dp_inner.acc_code,
        dp_inner.acc_name,
        dp_inner.doc_dt
      FROM ims_dailyprod dp_inner
      WHERE NULLIF(TRIM(dp_inner.doc_no::text), '') IS NOT NULL
    ) dp
    ORDER BY packing_number, (CASE WHEN dp.doc_dt IS NOT NULL THEN 0 ELSE 1 END), dp.doc_dt ASC NULLS LAST
  )`;

/** Builds CTEs: sa_meta + dp_meta + grouped + report_rows */
export function buildInventoryReportSql() {
  const stockHaving = `SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${IN_STORE})) > 0
       OR SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${PACKING_AREA})) > 0
       OR SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${QC_HOLD})) > 0`;

  const groupedCte = `
    ${SA_META_CTE},
    ${DP_META_CTE},
    grouped AS (
      SELECT
        ${PN("b")} AS packing_number,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${SELLABLE}))::bigint AS fg_stock_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${IN_STORE}))::bigint AS in_store_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${PACKING_AREA}))::bigint AS packing_area_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${QC_HOLD}))::bigint AS qc_hold_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${IS_OUT}))::bigint AS out_qty,
        COUNT(*) FILTER (WHERE (${IN_STORE}))::int AS in_store_boxes,
        COUNT(*) FILTER (WHERE (${PACKING_AREA}))::int AS packing_area_boxes,
        STRING_AGG(DISTINCT ${LOC_LABEL}, ', ') FILTER (WHERE (${SHOW_LOC})) AS location_details,
        COALESCE(ARRAY_AGG(DISTINCT b.location_id::text) FILTER (WHERE (${SHOW_LOC})), ARRAY[]::text[]) AS in_store_location_ids
      FROM ims_box_table b
      LEFT JOIN ims_location_master lm ON lm.location_id = b.location_id
      WHERE b.is_deleted = false AND ${PN("b")} IS NOT NULL
      GROUP BY ${PN("b")}
      HAVING ${stockHaving}
    ),
    report_rows AS (
      SELECT
        g.packing_number,
        g.fg_stock_qty,
        g.in_store_qty,
        g.packing_area_qty,
        g.qc_hold_qty,
        g.out_qty,
        g.in_store_boxes,
        g.packing_area_boxes,
        g.location_details,
        g.in_store_location_ids,
        COALESCE(sa.item_dcode::text, dp.item_dcode::text, '—') AS item_dcode,
        COALESCE(sa.item_code, dp.item_code, sa.item_dcode::text, dp.item_dcode::text, '—') AS item_code,
        COALESCE(sa.item_desc, dp.item_desc, '—') AS item_desc,
        COALESCE(sa.acc_code::text, dp.acc_code::text, '') AS customer_code,
        COALESCE(sa.acc_name, dp.acc_name, '—') AS customer_name,
        COALESCE(sa.doc_dt, dp.doc_dt) AS doc_dt
      FROM grouped g
      LEFT JOIN sa_meta sa ON sa.packing_number = g.packing_number
      LEFT JOIN dp_meta dp ON dp.packing_number = g.packing_number
    )`;

  return { values: [], groupedCte, groupWhere: "" };
}

function pageOrder(sortBy, sortCol, sortDir) {
  if (sortBy === "doc_dt") {
    return `f.doc_dt ${sortDir} NULLS LAST, NULLIF(regexp_replace(f.packing_number::text, '\\D', '', 'g'), '')::bigint DESC NULLS LAST`;
  }
  if (sortBy === "packing_number") {
    return `NULLIF(regexp_replace(f.packing_number::text, '\\D', '', 'g'), '')::bigint ${sortDir} NULLS LAST, f.packing_number ${sortDir}`;
  }
  const col = sortCol.includes(".") ? sortCol.replace(/^g\./, "f.") : `f.${sortCol}`;
  return `${col} ${sortDir} NULLS LAST`;
}

export function sqlPageSlice({ sortBy, sortCol, sortDir, limitIdx, offsetIdx }) {
  const order = pageOrder(sortBy, sortCol, sortDir);
  return `
    SELECT
      CONCAT(f.packing_number, ':', f.item_dcode, ':', COALESCE(f.customer_code, '')) AS id,
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
      f.doc_dt
    FROM filtered f
    ORDER BY ${order}
    LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
}
