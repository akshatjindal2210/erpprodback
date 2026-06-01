import dbQuery from "../../../config/db.js";
import { sqlBoxCountedAsOut, sqlBoxInHand } from "../utils/boxInventorySql.js";

/**
 * Inventory report (per packing number).
 * All quantities come from ims_box_table only:
 *   Total Stock  = in-hand boxes (not dispatched / not SA minus)
 *   In Store     = in-hand + location assigned
 *   Packing Area = in-hand + no location yet
 *   Out / Sold   = dispatched or stock-adjustment minus
 * Rule: Total Stock = In Store + Packing Area
 */

const PN_B = `NULLIF(TRIM(b.packing_number::text), '')`;
const PN_BX = `NULLIF(TRIM(bx.packing_number::text), '')`;
const PN_DP = `NULLIF(TRIM(dp.doc_no::text), '')`;

const SQL_IN_HAND = sqlBoxInHand("b");
const SQL_IN_HAND_BX = sqlBoxInHand("bx");
const SQL_IN_STORE = `${SQL_IN_HAND} AND b.location_id IS NOT NULL`;
const SQL_IN_STORE_BX = `${SQL_IN_HAND_BX} AND bx.location_id IS NOT NULL`;
const SQL_PACKING_AREA = `${SQL_IN_HAND} AND b.location_id IS NULL`;
const SQL_OUT = sqlBoxCountedAsOut("b");

const BOX_AGG_CTE = `
  box_agg AS (
    SELECT
      ${PN_B} AS packing_number,
      SUM(CASE WHEN ${SQL_IN_HAND} THEN COALESCE(b.qty, 0) ELSE 0 END)::bigint AS in_hand_qty,
      SUM(CASE WHEN ${SQL_IN_STORE} THEN COALESCE(b.qty, 0) ELSE 0 END)::bigint AS in_store_qty,
      SUM(CASE WHEN ${SQL_PACKING_AREA} THEN COALESCE(b.qty, 0) ELSE 0 END)::bigint AS packing_area_qty,
      SUM(CASE WHEN ${SQL_OUT} THEN COALESCE(b.qty, 0) ELSE 0 END)::bigint AS out_qty,
      COUNT(CASE WHEN ${SQL_IN_STORE} THEN 1 END)::int AS in_store_boxes,
      STRING_AGG(
        DISTINCT NULLIF(
          TRIM(COALESCE(lm.location_no, CONCAT(lm.rack_no::text, UPPER(COALESCE(lm.shelf_no::text, ''))))),
          ''
        ),
        ', '
      ) FILTER (WHERE ${SQL_IN_STORE}) AS location_details,
      COALESCE(
        ARRAY_AGG(DISTINCT b.location_id::text) FILTER (WHERE ${SQL_IN_STORE}),
        ARRAY[]::text[]
      ) AS in_store_location_ids
    FROM ims_box_table b
    LEFT JOIN ims_location_master lm ON lm.location_id = b.location_id
    WHERE b.is_deleted = false AND ${PN_B} IS NOT NULL
    GROUP BY ${PN_B}
  )
`;

const ROW_SELECT = `
  b.packing_number AS id,
  b.packing_number,
  b.item_dcode,
  b.item_code,
  b.item_desc,
  b.customer_code,
  b.customer_name,
  COALESCE(a.location_details, '—') AS location_details,
  COALESCE(a.in_store_location_ids, ARRAY[]::text[]) AS in_store_location_ids,
  COALESCE(a.in_hand_qty, 0)::bigint AS fg_stock_qty,
  COALESCE(a.in_store_qty, 0)::bigint AS in_store_qty,
  COALESCE(a.packing_area_qty, 0)::bigint AS packing_area_qty,
  COALESCE(a.out_qty, 0)::bigint AS out_qty,
  COALESCE(a.in_store_boxes, 0)::int AS in_store_boxes
`;

const SORT_COLUMNS = {
  packing_number: "b.packing_number",
  item_code: "b.item_code",
  item_desc: "b.item_desc",
  customer_name: "b.customer_name",
  fg_stock_qty: "a.in_hand_qty",
  in_store_qty: "a.in_store_qty",
  packing_area_qty: "a.packing_area_qty",
  out_qty: "a.out_qty",
  in_store_boxes: "a.in_store_boxes",
};

function toList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  return String(val).split(",").map((v) => v.trim()).filter(Boolean);
}

function toQty(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function buildBaseCte({ filters = {}, search } = {}) {
  const itemCodes = toList(filters.item_dcodes);
  const customerCodes = toList(filters.customer_codes);
  const packingNos = toList(filters.packing_numbers);
  const locationIds = toList(filters.location_ids);
  const values = [];

  const dpWhere = [
    `(
      dp.sticker_generated = true
      OR EXISTS (
        SELECT 1 FROM ims_box_table bx
        WHERE ${PN_BX} = ${PN_DP} AND ${SQL_IN_HAND_BX}
      )
    )`,
  ];

  const boxWhere = [`${PN_B} IS NOT NULL`];

  if (itemCodes.length) {
    values.push(itemCodes);
    const p = values.length;
    dpWhere.push(`dp.item_dcode::text = ANY($${p}::text[])`);
    boxWhere.push(`(dp.item_dcode::text = ANY($${p}::text[]) OR sa.item_dcode::text = ANY($${p}::text[]))`);
  }
  if (customerCodes.length) {
    values.push(customerCodes);
    const p = values.length;
    dpWhere.push(`dp.acc_code::text = ANY($${p}::text[])`);
    boxWhere.push(`(
      COALESCE(NULLIF(TRIM(dp.acc_code::text), ''), NULLIF(TRIM(b.override_cust::text), '')) = ANY($${p}::text[])
    )`);
  }
  if (packingNos.length) {
    values.push(packingNos);
    const p = values.length;
    dpWhere.push(`${PN_DP} = ANY($${p}::text[])`);
    boxWhere.push(`${PN_B} = ANY($${p}::text[])`);
  }
  if (locationIds.length) {
    values.push(locationIds);
    const p = values.length;
    dpWhere.push(`
      EXISTS (
        SELECT 1 FROM ims_box_table bx
        WHERE ${PN_BX} = ${PN_DP}
          AND bx.location_id::text = ANY($${p}::text[])
          AND ${SQL_IN_STORE_BX}
      )
    `);
    boxWhere.push(`
      EXISTS (
        SELECT 1 FROM ims_box_table bx
        WHERE ${PN_BX} = ${PN_B}
          AND bx.location_id::text = ANY($${p}::text[])
          AND ${SQL_IN_STORE_BX}
      )
    `);
  }

  const term = search && String(search).trim() ? `%${String(search).trim()}%` : null;
  if (term) {
    values.push(term);
    const p = values.length;
    dpWhere.push(`(
      ${PN_DP} ILIKE $${p}
      OR COALESCE(dp.item_dcode::text, '') ILIKE $${p}
      OR COALESCE(dp.acc_code::text, '') ILIKE $${p}
    )`);
    boxWhere.push(`(
      ${PN_B} ILIKE $${p}
      OR COALESCE(dp.item_dcode::text, '') ILIKE $${p}
      OR COALESCE(sa.item_dcode::text, '') ILIKE $${p}
      OR COALESCE(dp.acc_code::text, '') ILIKE $${p}
    )`);
  }

  const dpWhereSql = `WHERE ${dpWhere.join(" AND ")}`;
  const boxWhereSql = `WHERE ${boxWhere.join(" AND ")}`;

  const baseCteSql = `
    from_dailyprod AS (
      SELECT
        ${PN_DP} AS packing_number,
        dp.item_dcode::text AS item_dcode,
        COALESCE(dp.item_dcode::text, '—') AS item_code,
        '—'::text AS item_desc,
        dp.acc_code::text AS customer_code,
        COALESCE(NULLIF(TRIM(dp.acc_code::text), ''), '—') AS customer_name
      FROM ims_dailyprod dp
      ${dpWhereSql}
    ),
    from_boxes AS (
      SELECT
        ${PN_B} AS packing_number,
        COALESCE(MAX(dp.item_dcode::text), MAX(sa.item_dcode::text), '—') AS item_dcode,
        COALESCE(MAX(dp.item_dcode::text), MAX(sa.item_dcode::text), '—') AS item_code,
        '—'::text AS item_desc,
        COALESCE(
          MAX(NULLIF(TRIM(dp.acc_code::text), '')),
          MAX(NULLIF(TRIM(b.override_cust::text), ''))
        ) AS customer_code,
        '—'::text AS customer_name
      FROM ims_box_table b
      LEFT JOIN ims_dailyprod dp ON ${PN_DP} = ${PN_B}
      LEFT JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
      ${boxWhereSql}
      GROUP BY ${PN_B}
    ),
    base AS (
      SELECT
        fd.packing_number,
        fd.item_dcode,
        fd.item_code,
        fd.item_desc,
        COALESCE(
          NULLIF(TRIM(fd.customer_code::text), ''),
          NULLIF(TRIM(fd.customer_code::text), '—'),
          NULLIF(TRIM(fb.customer_code::text), ''),
          NULLIF(TRIM(fb.customer_code::text), '—')
        ) AS customer_code,
        '—'::text AS customer_name
      FROM from_dailyprod fd
      LEFT JOIN from_boxes fb ON trim(fd.packing_number::text) = trim(fb.packing_number::text)

      UNION

      SELECT fb.packing_number, fb.item_dcode, fb.item_code, fb.item_desc, fb.customer_code, fb.customer_name
      FROM from_boxes fb
      WHERE NOT EXISTS (
        SELECT 1 FROM from_dailyprod fd WHERE trim(fd.packing_number::text) = trim(fb.packing_number::text)
      )
    )`;

  return { values, baseCteSql };
}

/** DB hints for packings whose customer_code is missing in the report CTE. */
export async function findCustomerHintsForPackings(packingNumbers = []) {
  const list = [...new Set(packingNumbers.map((p) => String(p ?? "").trim()).filter(Boolean))];
  if (!list.length) return [];

  return dbQuery(
    `SELECT
       trim(x.pn::text) AS packing_number,
       COALESCE(
         NULLIF(trim(dp.acc_code::text), ''),
         NULLIF(trim(boxes.override_cust::text), '')
       ) AS customer_code,
       sa_fy.financial_year
     FROM unnest($1::text[]) AS x(pn)
     LEFT JOIN ims_dailyprod dp ON trim(dp.doc_no::text) = trim(x.pn::text)
     LEFT JOIN LATERAL (
       SELECT MAX(NULLIF(trim(b.override_cust::text), '')) AS override_cust
       FROM ims_box_table b
       WHERE trim(b.packing_number::text) = trim(x.pn::text)
         AND b.is_deleted = false
     ) boxes ON true
     LEFT JOIN LATERAL (
       SELECT MAX(sa.financial_year) AS financial_year
       FROM ims_stock_adjustment sa
       WHERE trim(sa.packing_number::text) = trim(x.pn::text)
         AND sa.is_deleted = false
         AND sa.financial_year IS NOT NULL
         AND NULLIF(trim(sa.financial_year::text), '') IS NOT NULL
     ) sa_fy ON true`,
    [list]
  );
}

function safeSortKey(sortBy) {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, sortBy) ? sortBy : "packing_number";
}

export async function getInventoryReportFilterOptions(filters = {}) {
  const { values, baseCteSql } = buildBaseCte({ filters });
  const withBase = `WITH ${baseCteSql}`;

  const [items, customers, packings, locations] = await Promise.all([
    dbQuery(
      `${withBase}
       SELECT DISTINCT rb.item_dcode::text AS id, rb.item_code, NULL::text AS item_desc
       FROM base rb ORDER BY rb.item_code ASC NULLS LAST`,
      values
    ),
    dbQuery(
      `${withBase}
       SELECT DISTINCT rb.customer_code::text AS id, rb.customer_name AS acc_name
       FROM base rb
       WHERE rb.customer_code IS NOT NULL AND NULLIF(TRIM(rb.customer_code::text), '') IS NOT NULL
       ORDER BY rb.customer_code ASC NULLS LAST`,
      values
    ),
    dbQuery(
      `${withBase}
       SELECT DISTINCT rb.packing_number::text AS id, rb.packing_number
       FROM base rb ORDER BY rb.packing_number DESC LIMIT 5000`,
      values
    ),
    dbQuery(
      `${withBase}
       SELECT DISTINCT lm.location_id::text AS id,
         COALESCE(lm.location_no, CONCAT(lm.rack_no::text, UPPER(COALESCE(lm.shelf_no::text, '')))) AS location_no
       FROM base rb
       INNER JOIN ims_box_table b ON ${PN_B} = rb.packing_number AND ${SQL_IN_STORE}
       INNER JOIN ims_location_master lm ON lm.location_id = b.location_id
       ORDER BY location_no ASC NULLS LAST`,
      values
    ),
  ]);

  return { items, customers, locations, packings };
}

export async function findInventoryReportFiltered(options = {}) {
  const { search, page = 1, limit = 500, sortBy = "packing_number", order = "DESC", filters = {} } = options;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 500));
  const offset = (safePage - 1) * safeLimit;

  const { values, baseCteSql } = buildBaseCte({ filters, search });
  const sortCol = SORT_COLUMNS[safeSortKey(sortBy)];
  const sortDir = String(order).toUpperCase() === "ASC" ? "ASC" : "DESC";

  const [{ count = 0 } = {}] = await dbQuery(
    `WITH ${baseCteSql} SELECT COUNT(*)::int AS count FROM base`,
    values
  );

  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;
  const rows = await dbQuery(
    `WITH ${baseCteSql}, ${BOX_AGG_CTE}
     SELECT ${ROW_SELECT}
     FROM base b
     LEFT JOIN box_agg a ON a.packing_number = b.packing_number
     ORDER BY ${sortCol} ${sortDir} NULLS LAST
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...values, safeLimit, offset]
  );

  const totals = await getInventoryReportTotals({ filters, search });

  return {
    data: rows,
    totals,
    total: toQty(count),
    page: safePage,
    limit: safeLimit,
  };
}

export async function getInventoryReportTotals({ filters = {}, search } = {}) {
  const { values, baseCteSql } = buildBaseCte({ filters, search });

  const [row] = await dbQuery(
    `WITH ${baseCteSql}, ${BOX_AGG_CTE}
     SELECT
       COALESCE(SUM(COALESCE(a.in_hand_qty, 0)), 0)::bigint AS fg_stock_qty,
       COALESCE(SUM(COALESCE(a.in_store_qty, 0)), 0)::bigint AS in_store_qty,
       COALESCE(SUM(COALESCE(a.packing_area_qty, 0)), 0)::bigint AS packing_area_qty,
       COALESCE(SUM(COALESCE(a.out_qty, 0)), 0)::bigint AS out_qty
     FROM base b
     LEFT JOIN box_agg a ON a.packing_number = b.packing_number`,
    values
  );

  return {
    fg_stock_qty: toQty(row?.fg_stock_qty),
    in_store_qty: toQty(row?.in_store_qty),
    packing_area_qty: toQty(row?.packing_area_qty),
    out_qty: toQty(row?.out_qty),
  };
}
