/**
 * Inventory report — API queries (buildInventoryReportSql → withFiltered → list).
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

// --- SQL helpers ---

function withFiltered(sql) {
  return `WITH ${sql.groupedCte},
filtered AS (SELECT g.* FROM report_rows g ${sql.groupWhere})`;
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

export async function findInventoryReportFiltered(options = {}) {
  const {
    page = 1,
    limit = 100,
    sortBy = "packing_number",
    order = "DESC",
    includeTotals = true,
  } = options;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(10000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  const sortCol = SORT_COL[sortBy] ?? SORT_COL.packing_number;
  const sortDir = String(order).toUpperCase() === "ASC" ? "ASC" : "DESC";

  const sql = buildInventoryReportSql();
  const limitIdx = sql.values.length + 1;
  const offsetIdx = sql.values.length + 2;
  const pageSql = sqlPageSlice({ sortBy, sortCol, sortDir, limitIdx, offsetIdx });
  const params = [...sql.values, safeLimit, offset];

  if (safePage === 1) {
    const sumSelect = includeTotals
      ? `,
           COALESCE(SUM(fg_stock_qty), 0)::bigint AS fg_stock_qty,
           COALESCE(SUM(in_store_qty), 0)::bigint AS in_store_qty,
           COALESCE(SUM(packing_area_qty), 0)::bigint AS packing_area_qty,
           COALESCE(SUM(qc_hold_qty), 0)::bigint AS qc_hold_qty,
           COALESCE(SUM(out_qty), 0)::bigint AS out_qty`
      : "";
    const sumCols = includeTotals
      ? `,
         st.fg_stock_qty AS _sum_fg_stock_qty,
         st.in_store_qty AS _sum_in_store_qty,
         st.packing_area_qty AS _sum_packing_area_qty,
         st.qc_hold_qty AS _sum_qc_hold_qty,
         st.out_qty AS _sum_out_qty`
      : "";

    const rows = await dbQuery(
      `${withFiltered(sql)},
       stats AS (
         SELECT COUNT(*)::int AS total_count${sumSelect}
         FROM filtered
       ),
       page AS (${pageSql})
       SELECT pg.*,
         st.total_count${sumCols}
       FROM page pg CROSS JOIN stats st`,
      params
    );
    const first = rows[0];
    return {
      data: rows.map(stripStatsCols),
      total: Number(first?.total_count) || rows.length,
      totals: includeTotals && first
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
