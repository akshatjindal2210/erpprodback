import dbQuery from "../../../config/db.js";
import {
  sqlBoxCountedAsOut,
  sqlBoxInHand,
  sqlBoxItemDcodeReport,
  sqlBoxCustomerCodeReport,
  sqlDailyprodLateralForBox,
  sqlDailyprodDocNoMatch,
} from "../utils/boxInventorySql.js";

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

const BOX_AGG_ITEM = sqlBoxItemDcodeReport("sa", "dp");
const BOX_AGG_CUSTOMER = sqlBoxCustomerCodeReport("b", "sa", "dp");
const BOX_AGG_DP_JOIN = sqlDailyprodLateralForBox("b", "sa", PN_B);
const BOX_BASE_CUSTOMER = BOX_AGG_CUSTOMER;

function buildBoxAggCte(locationParamIndex = null) {
  const inStoreScoped = locationParamIndex
    ? `${SQL_IN_HAND} AND b.location_id IS NOT NULL AND b.location_id::text = ANY($${locationParamIndex}::text[])`
    : SQL_IN_STORE;
  const inHandScoped = locationParamIndex ? inStoreScoped : SQL_IN_HAND;
  const packingAreaScoped = locationParamIndex ? "FALSE" : SQL_PACKING_AREA;

  return `
  box_agg AS (
    SELECT
      ${PN_B} AS packing_number,
      ${BOX_AGG_ITEM} AS item_dcode,
      ${BOX_AGG_CUSTOMER} AS customer_code,
      SUM(CASE WHEN ${inHandScoped} THEN COALESCE(b.qty, 0) ELSE 0 END)::bigint AS in_hand_qty,
      SUM(CASE WHEN ${inStoreScoped} THEN COALESCE(b.qty, 0) ELSE 0 END)::bigint AS in_store_qty,
      SUM(CASE WHEN ${packingAreaScoped} THEN COALESCE(b.qty, 0) ELSE 0 END)::bigint AS packing_area_qty,
      SUM(CASE WHEN ${SQL_OUT} THEN COALESCE(b.qty, 0) ELSE 0 END)::bigint AS out_qty,
      COUNT(CASE WHEN ${inStoreScoped} THEN 1 END)::int AS in_store_boxes,
      COUNT(CASE WHEN ${packingAreaScoped} THEN 1 END)::int AS packing_area_boxes,
      STRING_AGG(
        DISTINCT NULLIF(
          TRIM(COALESCE(lm.location_no, CONCAT(lm.rack_no::text, UPPER(COALESCE(lm.shelf_no::text, ''))))),
          ''
        ),
        ', '
      ) FILTER (WHERE ${inStoreScoped}) AS location_details,
      COALESCE(
        ARRAY_AGG(DISTINCT b.location_id::text) FILTER (WHERE ${inStoreScoped}),
        ARRAY[]::text[]
      ) AS in_store_location_ids
    FROM ims_box_table b
    LEFT JOIN ims_location_master lm ON lm.location_id = b.location_id
    LEFT JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
    ${BOX_AGG_DP_JOIN}
    WHERE b.is_deleted = false AND ${PN_B} IS NOT NULL
    GROUP BY ${PN_B}, ${BOX_AGG_ITEM}, ${BOX_AGG_CUSTOMER}
  )
`;
}

function buildActiveStockWhere(locationParamIndex = null) {
  if (locationParamIndex) {
    return `COALESCE(a.in_store_qty, 0) > 0`;
  }
  return `(COALESCE(a.in_store_qty, 0) > 0 OR COALESCE(a.packing_area_qty, 0) > 0)`;
}

const BOX_AGG_JOIN = `
  a.packing_number = b.packing_number
  AND a.item_dcode = b.item_dcode
  AND COALESCE(NULLIF(TRIM(a.customer_code::text), ''), '—') = COALESCE(NULLIF(TRIM(b.customer_code::text), ''), '—')
`;

const PACKING_AREA_SORT = {
  packing_number: "b.packing_number",
  box_count: "a.packing_area_boxes",
  stock_qty: "a.packing_area_qty",
};

const ROW_SELECT = `
  CONCAT(b.packing_number, ':', b.item_dcode, ':', COALESCE(b.customer_code, '')) AS id,
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
  let locationParamIndex = null;

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
    dpWhere.push(`(
      dp.acc_code::text = ANY($${p}::text[])
      OR EXISTS (
        SELECT 1 FROM ims_stock_adjustment sa
        WHERE sa.is_deleted = false
          AND sa.acc_code::text = ANY($${p}::text[])
          AND (
            trim(sa.packing_number::text) = trim(dp.doc_no::text)
            OR (
              nullif(trim(sa.packing_number::text), '-') ~ '^[0-9]+$'
              AND nullif(trim(dp.doc_no::text), '-') ~ '^[0-9]+$'
              AND trim(sa.packing_number::text)::numeric = trim(dp.doc_no::text)::numeric
            )
          )
      )
    )`);
    boxWhere.push(`(${BOX_BASE_CUSTOMER} = ANY($${p}::text[]))`);
  }
  if (packingNos.length) {
    values.push(packingNos);
    const p = values.length;
    dpWhere.push(`${PN_DP} = ANY($${p}::text[])`);
    boxWhere.push(`${PN_B} = ANY($${p}::text[])`);
  }
  if (locationIds.length) {
    values.push(locationIds);
    locationParamIndex = values.length;
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
      OR COALESCE(sa.acc_code::text, '') ILIKE $${p}
    )`);
  }

  const dpWhereSql = `WHERE ${dpWhere.join(" AND ")}`;
  const boxWhereSql = `WHERE ${boxWhere.join(" AND ")}`;

  const baseCteSql = `
    from_dailyprod AS (
      SELECT
        ${PN_DP} AS packing_number,
        COALESCE(dp.item_dcode::text, '—') AS item_dcode,
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
        COALESCE(sa.item_dcode::text, dp.item_dcode::text, '—') AS item_dcode,
        COALESCE(sa.item_dcode::text, dp.item_dcode::text, '—') AS item_code,
        '—'::text AS item_desc,
        ${BOX_BASE_CUSTOMER} AS customer_code,
        '—'::text AS customer_name
      FROM ims_box_table b
      LEFT JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
      ${BOX_AGG_DP_JOIN}
      ${boxWhereSql}
      GROUP BY ${PN_B}, COALESCE(sa.item_dcode::text, dp.item_dcode::text, '—'), ${BOX_BASE_CUSTOMER}
    ),
    base AS (
      SELECT fb.packing_number, fb.item_dcode, fb.item_code, fb.item_desc, fb.customer_code, fb.customer_name
      FROM from_boxes fb

      UNION

      SELECT fd.packing_number, fd.item_dcode, fd.item_code, fd.item_desc, fd.customer_code, fd.customer_name
      FROM from_dailyprod fd
      WHERE NOT EXISTS (
        SELECT 1 FROM from_boxes fb
        WHERE trim(fd.packing_number::text) = trim(fb.packing_number::text)
          AND COALESCE(fd.item_dcode, '—') = fb.item_dcode
      )
    )`;

  return { values, baseCteSql, locationParamIndex };
}

/** DB hints for packings whose customer_code is missing in the report CTE. */
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
       WHERE (
         trim(b.packing_number::text) = trim(x.pn::text)
         OR (
           nullif(trim(b.packing_number::text), '-') ~ '^[0-9]+$'
           AND nullif(trim(x.pn::text), '-') ~ '^[0-9]+$'
           AND trim(b.packing_number::text)::numeric = trim(x.pn::text)::numeric
         )
         OR (
           b.sa_entry_type = 'stock_in'
           AND b.sa_id IS NOT NULL
           AND b.box_no_uid::text ~ ('(^|_)' || trim(x.pn::text) || '_SA')
         )
       )
       AND b.is_deleted = false
     ) boxes ON true
     LEFT JOIN LATERAL (
       SELECT MAX(NULLIF(trim(sa.acc_code::text), '')) AS acc_code
       FROM ims_box_table b
       INNER JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
       WHERE (
         trim(b.packing_number::text) = trim(x.pn::text)
         OR (
           nullif(trim(b.packing_number::text), '-') ~ '^[0-9]+$'
           AND nullif(trim(x.pn::text), '-') ~ '^[0-9]+$'
           AND trim(b.packing_number::text)::numeric = trim(x.pn::text)::numeric
         )
         OR (
           b.sa_entry_type = 'stock_in'
           AND b.sa_id IS NOT NULL
           AND b.box_no_uid::text ~ ('(^|_)' || trim(x.pn::text) || '_SA')
         )
       )
       AND b.is_deleted = false
     ) sa_hint ON true
     LEFT JOIN LATERAL (
       SELECT
         MAX(sa.financial_year) AS financial_year,
         MAX(NULLIF(trim(sa.acc_code::text), '')) AS acc_code
       FROM ims_stock_adjustment sa
       WHERE (
         trim(sa.packing_number::text) = trim(x.pn::text)
         OR (
           nullif(trim(sa.packing_number::text), '-') ~ '^[0-9]+$'
           AND nullif(trim(x.pn::text), '-') ~ '^[0-9]+$'
           AND trim(sa.packing_number::text)::numeric = trim(x.pn::text)::numeric
         )
       )
       AND sa.is_deleted = false
     ) sa_hdr ON true`,
    [list]
  );
}

function safeSortKey(sortBy) {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, sortBy) ? sortBy : "packing_number";
}

const FILTER_OPTION_FIELDS = new Set(["items", "customers", "locations", "packings"]);

export async function getInventoryReportFilterOptions(filters = {}, { fields = null } = {}) {
  const requested = fields?.length
    ? fields.filter((f) => FILTER_OPTION_FIELDS.has(f))
    : [...FILTER_OPTION_FIELDS];
  if (!requested.length) {
    return { items: [], customers: [], locations: [], packings: [] };
  }

  const { values, baseCteSql, locationParamIndex } = buildBaseCte({ filters });
  const boxAggCte = buildBoxAggCte(locationParamIndex);
  const activeStockWhere = buildActiveStockWhere(locationParamIndex);
  const withBase = `WITH ${baseCteSql}, ${boxAggCte}`;

  const queries = {};
  if (requested.includes("items")) {
    queries.items = dbQuery(
      `${withBase}
       SELECT DISTINCT rb.item_dcode::text AS id, rb.item_code, NULL::text AS item_desc
       FROM base rb ORDER BY rb.item_code ASC NULLS LAST`,
      values
    );
  }
  if (requested.includes("customers")) {
    queries.customers = dbQuery(
      `${withBase}
       SELECT kind, id, acc_name, packing_number FROM (
         SELECT DISTINCT
           'known'::text AS kind,
           NULLIF(TRIM(a.customer_code::text), '')::text AS id,
           COALESCE(NULLIF(TRIM(b.customer_name::text), ''), '—')::text AS acc_name,
           NULL::text AS packing_number
         FROM base b
         INNER JOIN box_agg a ON ${BOX_AGG_JOIN}
         WHERE ${activeStockWhere}
           AND NULLIF(TRIM(a.customer_code::text), '') IS NOT NULL
           AND TRIM(a.customer_code::text) <> '—'

         UNION ALL

         SELECT DISTINCT
           'resolve'::text AS kind,
           NULL::text AS id,
           '—'::text AS acc_name,
           b.packing_number::text AS packing_number
         FROM base b
         INNER JOIN box_agg a ON ${BOX_AGG_JOIN}
         WHERE ${activeStockWhere}
           AND (
             a.customer_code IS NULL
             OR NULLIF(TRIM(a.customer_code::text), '') IS NULL
             OR TRIM(a.customer_code::text) = '—'
           )
       ) t
       ORDER BY kind, id NULLS LAST, packing_number ASC NULLS LAST`,
      values
    );
  }
  if (requested.includes("packings")) {
    queries.packings = dbQuery(
      `${withBase}
       SELECT DISTINCT rb.packing_number::text AS id, rb.packing_number
       FROM base rb ORDER BY rb.packing_number DESC LIMIT 5000`,
      values
    );
  }
  if (requested.includes("locations")) {
    queries.locations = dbQuery(
      `${withBase}
       SELECT id, location_no FROM (
         SELECT DISTINCT lm.location_id::text AS id,
           COALESCE(lm.location_no, CONCAT(lm.rack_no::text, UPPER(COALESCE(lm.shelf_no::text, '')))) AS location_no,
           lm.rack_no,
           lm.shelf_no
         FROM base rb
         INNER JOIN ims_box_table b ON ${PN_B} = rb.packing_number AND ${SQL_IN_STORE}
         INNER JOIN ims_location_master lm ON lm.location_id = b.location_id
       ) t
       ORDER BY NULLIF(regexp_replace(rack_no, '\\D', '', 'g'), '')::bigint ASC NULLS LAST, shelf_no ASC NULLS LAST`,
      values
    );
  }

  const entries = await Promise.all(
    Object.entries(queries).map(async ([key, promise]) => [key, await promise])
  );

  return {
    items: [],
    customers: [],
    locations: [],
    packings: [],
    ...Object.fromEntries(entries),
  };
}

export async function findInventoryReportFiltered(options = {}) {
  const {
    search,
    page = 1,
    limit = 500,
    sortBy = "packing_number",
    order = "DESC",
    filters = {},
    includeTotals = true,
    fetchAll = false,
  } = options;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = fetchAll
    ? Math.min(50000, Math.max(1, Number(limit) || 50000))
    : Math.min(1000, Math.max(1, Number(limit) || 500));
  const offset = (safePage - 1) * safeLimit;

  const { values, baseCteSql, locationParamIndex } = buildBaseCte({ filters, search });
  const boxAggCte = buildBoxAggCte(locationParamIndex);
  const activeStockWhere = buildActiveStockWhere(locationParamIndex);
  const sortCol = SORT_COLUMNS[safeSortKey(sortBy)];
  const sortDir = String(order).toUpperCase() === "ASC" ? "ASC" : "DESC";

  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;
  const rowsSql = `
    WITH ${baseCteSql}, ${boxAggCte}
     SELECT ${ROW_SELECT}
     FROM base b
     LEFT JOIN box_agg a ON ${BOX_AGG_JOIN}
     WHERE ${activeStockWhere}
     ORDER BY ${sortCol} ${sortDir} NULLS LAST
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  if (fetchAll) {
    const rowsPromise = dbQuery(rowsSql, [...values, safeLimit, offset]);
    const totalsPromise = includeTotals
      ? getInventoryReportTotals({ filters, search })
      : Promise.resolve(null);
    const [rows, totals] = await Promise.all([rowsPromise, totalsPromise]);

    return {
      data: rows,
      totals,
      total: toQty(rows.length),
      page: safePage,
      limit: safeLimit,
    };
  }

  const countSql = `
    WITH ${baseCteSql}, ${boxAggCte}
     SELECT COUNT(*)::int AS count
     FROM base b
     LEFT JOIN box_agg a ON ${BOX_AGG_JOIN}
     WHERE ${activeStockWhere}`;

  const countPromise = dbQuery(countSql, values);
  const rowsPromise = dbQuery(rowsSql, [...values, safeLimit, offset]);
  const totalsPromise = includeTotals
    ? getInventoryReportTotals({ filters, search })
    : Promise.resolve(null);

  const [[{ count = 0 } = {}], rows, totals] = await Promise.all([
    countPromise,
    rowsPromise,
    totalsPromise,
  ]);

  return {
    data: rows,
    totals,
    total: toQty(count),
    page: safePage,
    limit: safeLimit,
  };
}

export async function getInventoryReportTotals({ filters = {}, search } = {}) {
  const { values, baseCteSql, locationParamIndex } = buildBaseCte({ filters, search });
  const boxAggCte = buildBoxAggCte(locationParamIndex);
  const activeStockWhere = buildActiveStockWhere(locationParamIndex);

  const [row] = await dbQuery(
    `WITH ${baseCteSql}, ${boxAggCte}
     SELECT
       COALESCE(SUM(COALESCE(a.in_hand_qty, 0)), 0)::bigint AS fg_stock_qty,
       COALESCE(SUM(COALESCE(a.in_store_qty, 0)), 0)::bigint AS in_store_qty,
       COALESCE(SUM(COALESCE(a.packing_area_qty, 0)), 0)::bigint AS packing_area_qty,
       COALESCE(SUM(COALESCE(a.out_qty, 0)), 0)::bigint AS out_qty
     FROM base b
     LEFT JOIN box_agg a ON ${BOX_AGG_JOIN}
     WHERE ${activeStockWhere}`,
    values
  );

  return {
    fg_stock_qty: toQty(row?.fg_stock_qty),
    in_store_qty: toQty(row?.in_store_qty),
    packing_area_qty: toQty(row?.packing_area_qty),
    out_qty: toQty(row?.out_qty),
  };
}

/**
 * Packing area summary — same row keys and quantities as inventory report `packing_area_qty`.
 * Only rows with stock still in packing area (no location) are returned.
 */
export async function findPackingAreaSummary(options = {}) {
  const { search, sort = {}, page = 1, limit = 1000, filters = {} } = options;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const { values, baseCteSql, locationParamIndex } = buildBaseCte({ filters, search });
  const boxAggCte = buildBoxAggCte(locationParamIndex);
  const sortBy = PACKING_AREA_SORT[sort.by] || "b.packing_number";
  const sortOrder = sort.order === "DESC" ? "DESC" : "ASC";

  const [{ count = 0 } = {}] = await dbQuery(
    `WITH ${baseCteSql}, ${boxAggCte}
     SELECT COUNT(*)::int AS count
     FROM base b
     INNER JOIN box_agg a ON ${BOX_AGG_JOIN}
     WHERE COALESCE(a.packing_area_qty, 0) > 0`,
    values
  );

  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;

  const rows = await dbQuery(
    `WITH ${baseCteSql}, ${boxAggCte}
     SELECT
       b.packing_number,
       b.item_dcode,
       b.customer_code AS acc_code,
       COALESCE(a.packing_area_qty, 0)::bigint AS stock_qty,
       COALESCE(a.packing_area_boxes, 0)::int AS box_count,
       dp.doc_dt,
       dp.job_card_no
     FROM base b
     INNER JOIN box_agg a ON ${BOX_AGG_JOIN}
     LEFT JOIN LATERAL (
       SELECT dp2.doc_dt, dp2.job_card_no
       FROM ims_dailyprod dp2
       WHERE ${sqlDailyprodDocNoMatch("dp2.doc_no", "b.packing_number")}
       ORDER BY
         (CASE WHEN b.item_dcode IS NOT NULL AND b.item_dcode <> '—'
                    AND dp2.item_dcode::text = b.item_dcode THEN 0 ELSE 1 END) ASC,
         (CASE WHEN b.customer_code IS NOT NULL AND TRIM(b.customer_code::text) <> ''
                    AND TRIM(dp2.acc_code::text) = TRIM(b.customer_code::text) THEN 0 ELSE 1 END) ASC
       LIMIT 1
     ) dp ON true
     WHERE COALESCE(a.packing_area_qty, 0) > 0
     ORDER BY ${sortBy} ${sortOrder} NULLS LAST
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count) / safeLimit) || 0,
  };
}
