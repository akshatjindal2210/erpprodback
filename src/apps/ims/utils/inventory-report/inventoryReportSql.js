/**
 * Inventory Report SQL
 * --------------------
 * Flow (3 steps):
 *   1. grouped     → boxes se packing-wise qty (total/sellable, in store, packing area, QC)
 *   2. report_rows → grouped + SA/dailyprod (item, customer, date) — ek hi join
 *   3. filtered    → user filters (item, customer, search…)
 *   4. page        → sort + limit (koi extra join nahi)
 */

import { sqlBoxSellable, sqlBoxOnQcHold, sqlBoxCountedAsOut, sqlDailyprodDocNoMatch, sqlDocDtFromDailyprod, sqlDocDtText } from "../box/boxInventorySql.js";

const PN = (alias) => `NULLIF(TRIM(${alias}.packing_number::text), '')`;
const TRIM_TXT = (expr) => `NULLIF(TRIM((${expr})::text), '')`;
const LOC_LABEL = `NULLIF(TRIM(COALESCE(lm.location_no, CONCAT(lm.rack_no::text, UPPER(COALESCE(lm.shelf_no::text, ''))))), '')`;

// Box zone rules (same as box inventory)
const SELLABLE = sqlBoxSellable("b");
const SELLABLE_BX = sqlBoxSellable("bx");
const QC_HOLD = sqlBoxOnQcHold("b");
const IN_STORE = `${SELLABLE} AND b.location_id IS NOT NULL`;
const IN_STORE_BX = `${SELLABLE_BX} AND bx.location_id IS NOT NULL`;
const QC_HOLD_BX = sqlBoxOnQcHold("bx");
const QC_HOLD_LOC = `${QC_HOLD} AND b.location_id IS NOT NULL`;
const QC_HOLD_BX_LOC = `${QC_HOLD_BX} AND bx.location_id IS NOT NULL`;
const PACKING_AREA = `${SELLABLE} AND b.location_id IS NULL`;
const SHOW_LOC = `(${IN_STORE}) OR (${QC_HOLD_LOC})`;
const IS_OUT = sqlBoxCountedAsOut("b");

/**
 * Step 2 helper — packing number se SA + dailyprod (sirf ek baar).
 * Pehle SA prefer, phir dailyprod fallback.
 */
function sqlPackMetaByPacking(rowAlias = "g") {
  const pn = PN(rowAlias);
  return `
    LEFT JOIN LATERAL (
      SELECT
        ${sqlDocDtText("sa.doc_dt")} AS doc_dt,
        sa.item_dcode,
        sa.acc_code,
        ${TRIM_TXT("sa.item_code")} AS item_code,
        ${TRIM_TXT("sa.item_desc")} AS item_desc,
        ${TRIM_TXT("sa.acc_name")} AS acc_name
      FROM ims_stock_adjustment sa
      WHERE sa.is_deleted = false
        AND sa.approved = true
        AND sa.entry_type IN ('add', 'minus')
        AND NULLIF(TRIM(sa.packing_number::text), '') = ${pn}
      ORDER BY sa.approved_at DESC NULLS LAST
      LIMIT 1
    ) sa ON true
    LEFT JOIN LATERAL (
      SELECT
        ${sqlDocDtFromDailyprod("dp")} AS doc_dt,
        dp.item_dcode,
        dp.acc_code,
        ${TRIM_TXT("dp.item_code")} AS item_code,
        ${TRIM_TXT("dp.item_desc")} AS item_desc,
        ${TRIM_TXT("dp.acc_name")} AS acc_name
      FROM ims_dailyprod dp
      WHERE ${sqlDailyprodDocNoMatch("dp.doc_no", pn)}
      ORDER BY dp.doc_dt ASC NULLS LAST
      LIMIT 1
    ) dp ON true`;
}

/** Legacy export — packing-area summary etc. */
export function sqlPackMetaJoins(rowAlias = "f") {
  return sqlPackMetaByPacking(rowAlias);
}

function toList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  return String(val).split(",").map((v) => v.trim()).filter(Boolean);
}

/**
 * Builds CTEs: grouped + report_rows
 * Returns { values, groupedCte, groupWhere } for list / dropdown / totals.
 */
export function buildInventoryReportSql({ filters = {}, search } = {}) {
  const itemCodes = toList(filters.item_dcodes);
  const customerCodes = toList(filters.customer_codes);
  const packingNos = toList(filters.packing_numbers);
  const locationIds = toList(filters.location_ids);
  const values = [];
  let locIdx = null;

  // --- box-level filters (before group by) ---
  const boxWhere = ["b.is_deleted = false", `${PN("b")} IS NOT NULL`];
  if (packingNos.length) {
    values.push(packingNos);
    boxWhere.push(`${PN("b")} = ANY($${values.length}::text[])`);
  }
  if (locationIds.length) {
    values.push(locationIds);
    locIdx = values.length;
    boxWhere.push(`EXISTS (
      SELECT 1 FROM ims_box_table bx
      WHERE ${PN("bx")} = ${PN("b")}
        AND bx.is_deleted = false
        AND bx.location_id::text = ANY($${locIdx}::text[])
        AND ((${IN_STORE_BX}) OR (${QC_HOLD_BX_LOC}))
    )`);
  }

  const inStore = locIdx
    ? `${SELLABLE} AND b.location_id IS NOT NULL AND b.location_id::text = ANY($${locIdx}::text[])`
    : IN_STORE;
  const packingArea = locIdx ? "FALSE" : PACKING_AREA;
  const qcHold = locIdx ? `${QC_HOLD_LOC} AND b.location_id::text = ANY($${locIdx}::text[])` : QC_HOLD;
  // Total stock = sellable only (in store + packing area); QC hold is shown separately.
  const totalStock = locIdx ? inStore : SELLABLE;
  const locDisplay = locIdx ? `((${inStore}) OR (${qcHold}))` : SHOW_LOC;

  const stockHaving = locIdx
    ? `SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${inStore})) > 0
       OR SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${qcHold})) > 0`
    : `SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${inStore})) > 0
       OR SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${packingArea})) > 0
       OR SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${qcHold})) > 0`;

  // --- row-level filters (after item/customer resolved) ---
  const rowFilters = [];
  if (itemCodes.length) {
    values.push(itemCodes);
    rowFilters.push(`g.item_dcode = ANY($${values.length}::text[])`);
  }
  if (customerCodes.length) {
    values.push(customerCodes);
    rowFilters.push(`g.customer_code = ANY($${values.length}::text[])`);
  }
  const term = search != null && String(search).trim() ? `%${String(search).trim()}%` : null;
  if (term) {
    values.push(term);
    const p = values.length;
    rowFilters.push(`(g.packing_number ILIKE $${p} OR g.item_dcode ILIKE $${p} OR g.item_code ILIKE $${p} OR g.customer_code ILIKE $${p})`);
  }
  const groupWhere = rowFilters.length ? `WHERE ${rowFilters.join(" AND ")}` : "";

  const groupedCte = `
    grouped AS (
      SELECT
        ${PN("b")} AS packing_number,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${totalStock}))::bigint AS fg_stock_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${inStore}))::bigint AS in_store_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${packingArea}))::bigint AS packing_area_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${qcHold}))::bigint AS qc_hold_qty,
        SUM(COALESCE(b.qty, 0)) FILTER (WHERE (${IS_OUT}))::bigint AS out_qty,
        COUNT(*) FILTER (WHERE (${inStore}))::int AS in_store_boxes,
        COUNT(*) FILTER (WHERE (${packingArea}))::int AS packing_area_boxes,
        STRING_AGG(DISTINCT ${LOC_LABEL}, ', ') FILTER (WHERE (${locDisplay})) AS location_details,
        COALESCE(ARRAY_AGG(DISTINCT b.location_id::text) FILTER (WHERE (${locDisplay})), ARRAY[]::text[]) AS in_store_location_ids
      FROM ims_box_table b
      LEFT JOIN ims_location_master lm ON lm.location_id = b.location_id
      WHERE ${boxWhere.join(" AND ")}
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
        COALESCE(${TRIM_TXT("sa.item_dcode::text")}, ${TRIM_TXT("dp.item_dcode::text")}, '—') AS item_dcode,
        COALESCE(${TRIM_TXT("sa.item_code")}, ${TRIM_TXT("dp.item_code")}, ${TRIM_TXT("sa.item_dcode::text")}, ${TRIM_TXT("dp.item_dcode::text")}, '—') AS item_code,
        COALESCE(${TRIM_TXT("sa.item_desc")}, ${TRIM_TXT("dp.item_desc")}, '—') AS item_desc,
        COALESCE(${TRIM_TXT("sa.acc_code::text")}, ${TRIM_TXT("dp.acc_code::text")}, '') AS customer_code,
        COALESCE(${TRIM_TXT("sa.acc_name")}, ${TRIM_TXT("dp.acc_name")}, '—') AS customer_name,
        COALESCE(sa.doc_dt, dp.doc_dt) AS doc_dt
      FROM grouped g
      ${sqlPackMetaByPacking("g")}
    )`;

  return { values, groupedCte, groupWhere };
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

/** Step 4 — page rows (columns already in report_rows). */
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
