/**
 * Inventory report — API queries (buildInventoryReportSql → withFiltered → list / dropdown).
 */

import dbQuery from "../../../../config/db.js";
import { buildInventoryReportSql, sqlPageSlice } from "./inventoryReportSql.js";

const SORT_COL = {
  packing_number: "packing_number",
  item_code: "item_dcode",
  item_desc: "item_dcode",
  customer_name: "customer_code",
  doc_dt: "doc_dt",
  fg_stock_qty: "fg_stock_qty",
  in_store_qty: "in_store_qty",
  packing_area_qty: "packing_area_qty",
  qc_hold_qty: "qc_hold_qty",
  out_qty: "out_qty",
  in_store_boxes: "in_store_boxes",
};

const DROPDOWN_FIELDS = new Set(["items", "customers", "locations", "packings"]);

// --- SQL helpers ---

function withFiltered(sql) {
  return `WITH ${sql.groupedCte},
filtered AS (SELECT g.* FROM report_rows g ${sql.groupWhere})`;
}

function asSubquery(sql) {
  return `${withFiltered(sql)} SELECT * FROM filtered`;
}

// --- response helpers ---

function toQty(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function mapTotals(row) {
  if (!row) return null;
  return {
    fg_stock_qty: toQty(row.fg_stock_qty),
    in_store_qty: toQty(row.in_store_qty),
    packing_area_qty: toQty(row.packing_area_qty),
    qc_hold_qty: toQty(row.qc_hold_qty),
    out_qty: toQty(row.out_qty),
  };
}

function stripStatsCols(row) {
  if (!row) return row;
  const {
    total_count: _t,
    _sum_fg_stock_qty: _a,
    _sum_in_store_qty: _b,
    _sum_packing_area_qty: _c,
    _sum_qc_hold_qty: _d,
    _sum_out_qty: _e,
    ...rest
  } = row;
  return rest;
}

// --- API ---

export async function getInventoryReportFilterOptions(filters = {}, { fields = null } = {}) {
  const want = fields?.length ? fields.filter((f) => DROPDOWN_FIELDS.has(f)) : [...DROPDOWN_FIELDS];
  if (!want.length) return { items: [], customers: [], locations: [], packings: [] };

  const sql = buildInventoryReportSql({ filters });
  const sub = asSubquery(sql);
  const { values } = sql;
  const queries = {};

  if (want.includes("items")) {
    queries.items = dbQuery(
      `SELECT DISTINCT g.item_dcode::text AS id, g.item_code, NULLIF(TRIM(g.item_desc), '—') AS item_desc
       FROM (${sub}) g
       WHERE TRIM(g.item_dcode) NOT IN ('', '—') AND TRIM(g.item_code) NOT IN ('', '—')
       ORDER BY g.item_code`,
      values
    );
  }
  if (want.includes("customers")) {
    queries.customers = dbQuery(
      `SELECT DISTINCT NULLIF(TRIM(g.customer_code::text), '') AS id
       FROM (${sub}) g
       WHERE NULLIF(TRIM(g.customer_code::text), '') IS NOT NULL AND TRIM(g.customer_code) <> '—'
       ORDER BY id`,
      values
    );
  }
  if (want.includes("packings")) {
    queries.packings = dbQuery(
      `SELECT DISTINCT g.packing_number::text AS id, g.packing_number
       FROM (${sub}) g ORDER BY g.packing_number DESC LIMIT 5000`,
      values
    );
  }
  if (want.includes("locations")) {
    queries.locations = dbQuery(
      `SELECT id, location_no FROM (
         SELECT DISTINCT lm.location_id::text AS id,
           COALESCE(lm.location_no, CONCAT(lm.rack_no::text, UPPER(COALESCE(lm.shelf_no::text, '')))) AS location_no,
           lm.rack_no, lm.shelf_no
         FROM (${sub}) g
         CROSS JOIN LATERAL unnest(g.in_store_location_ids) AS loc(id)
         JOIN ims_location_master lm ON lm.location_id::text = loc.id
       ) t
       ORDER BY NULLIF(regexp_replace(rack_no, '\\D', '', 'g'), '')::bigint NULLS LAST, shelf_no NULLS LAST`,
      values
    );
  }

  const entries = await Promise.all(Object.entries(queries).map(async ([k, p]) => [k, await p]));
  return { items: [], customers: [], locations: [], packings: [], ...Object.fromEntries(entries) };
}

export async function findInventoryReportFiltered(options = {}) {
  const {
    search,
    page = 1,
    limit = 100,
    sortBy = "packing_number",
    order = "DESC",
    filters = {},
    includeTotals = true,
  } = options;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  const sortCol = SORT_COL[sortBy] ?? SORT_COL.packing_number;
  const sortDir = String(order).toUpperCase() === "ASC" ? "ASC" : "DESC";

  const sql = buildInventoryReportSql({ filters, search });
  const limitIdx = sql.values.length + 1;
  const offsetIdx = sql.values.length + 2;
  const pageSql = sqlPageSlice({ sortBy, sortCol, sortDir, limitIdx, offsetIdx });
  const params = [...sql.values, safeLimit, offset];

  if (safePage === 1 && includeTotals) {
    const rows = await dbQuery(
      `${withFiltered(sql)},
       stats AS (
         SELECT COUNT(*)::int AS total_count,
           COALESCE(SUM(fg_stock_qty), 0)::bigint AS fg_stock_qty,
           COALESCE(SUM(in_store_qty), 0)::bigint AS in_store_qty,
           COALESCE(SUM(packing_area_qty), 0)::bigint AS packing_area_qty,
           COALESCE(SUM(qc_hold_qty), 0)::bigint AS qc_hold_qty,
           COALESCE(SUM(out_qty), 0)::bigint AS out_qty
         FROM filtered
       ),
       page AS (${pageSql})
       SELECT pg.*,
         st.total_count,
         st.fg_stock_qty AS _sum_fg_stock_qty,
         st.in_store_qty AS _sum_in_store_qty,
         st.packing_area_qty AS _sum_packing_area_qty,
         st.qc_hold_qty AS _sum_qc_hold_qty,
         st.out_qty AS _sum_out_qty
       FROM page pg CROSS JOIN stats st`,
      params
    );
    const first = rows[0];
    return {
      data: rows.map(stripStatsCols),
      total: Number(first?.total_count) || rows.length,
      totals: first
        ? mapTotals({
            fg_stock_qty: first._sum_fg_stock_qty,
            in_store_qty: first._sum_in_store_qty,
            packing_area_qty: first._sum_packing_area_qty,
            qc_hold_qty: first._sum_qc_hold_qty,
            out_qty: first._sum_out_qty,
          })
        : null,
      page: safePage,
      limit: safeLimit,
    };
  }

  const rows = await dbQuery(`${withFiltered(sql)}, page AS (${pageSql}) SELECT * FROM page`, params);
  return { data: rows.map(stripStatsCols), totals: null, total: undefined, page: safePage, limit: safeLimit };
}

export async function getInventoryReportTotals({ filters = {}, search } = {}) {
  const sql = buildInventoryReportSql({ filters, search });
  const [row] = await dbQuery(
    `${withFiltered(sql)}
     SELECT COALESCE(SUM(fg_stock_qty), 0)::bigint AS fg_stock_qty,
       COALESCE(SUM(in_store_qty), 0)::bigint AS in_store_qty,
       COALESCE(SUM(packing_area_qty), 0)::bigint AS packing_area_qty,
       COALESCE(SUM(qc_hold_qty), 0)::bigint AS qc_hold_qty,
       COALESCE(SUM(out_qty), 0)::bigint AS out_qty
     FROM filtered`,
    sql.values
  );
  return mapTotals(row) ?? { fg_stock_qty: 0, in_store_qty: 0, packing_area_qty: 0, qc_hold_qty: 0, out_qty: 0 };
}

export async function findPackingAreaSummary(options = {}) {
  const { search, sort = {}, page = 1, limit = 1000, filters = {} } = options;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  const sortBy = { packing_number: "packing_number", box_count: "packing_area_boxes", stock_qty: "packing_area_qty" }[
    sort.by
  ] || "packing_number";
  const sortOrder = sort.order === "DESC" ? "DESC" : "ASC";

  const sql = buildInventoryReportSql({ filters, search });
  const limitIdx = sql.values.length + 1;
  const offsetIdx = sql.values.length + 2;

  const [{ count = 0 } = {}] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM (${asSubquery(sql)}) g WHERE g.packing_area_qty > 0`,
    sql.values
  );

  const rows = await dbQuery(
    `${withFiltered(sql)}
     SELECT g.packing_number, g.item_dcode, g.customer_code AS acc_code,
       g.item_code, g.item_desc, g.customer_name AS acc_name,
       g.packing_area_qty::bigint AS stock_qty,
       g.packing_area_boxes::int AS box_count,
       g.doc_dt
     FROM filtered g
     WHERE g.packing_area_qty > 0
     ORDER BY ${sortBy} ${sortOrder} NULLS LAST
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...sql.values, safeLimit, offset]
  );

  const total = Number(count) || 0;
  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 0 };
}
