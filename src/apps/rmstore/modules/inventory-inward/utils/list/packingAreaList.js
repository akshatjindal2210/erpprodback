/**
 * Coil Area list — coils with no location (not yet racked).
 * By MRN = group by mrn_uid. By Coil = individual coils via findCoils({ coil_area: true }).
 */

import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

const TABLE = T.COIL_TABLE;

const PACKING_AREA_WHERE = (alias = "c") => [
  `${alias}.is_deleted = false`,
  `${alias}.location_id IS NULL`,
  `COALESCE(${alias}.status, 'active') = 'active'`,
  // By-MRN tab only: real MRN stickers (SA Add coils show under By Coil via findCoils coil_area)
  `NULLIF(TRIM(${alias}.mrn_uid::text), '') IS NOT NULL`,
];

const SUMMARY_SORT = {
  mrn_uid: "mrn_uid",
  mrn_no: "mrn_no",
  coil_count: "coil_count",
  stock_qty: "stock_qty",
  created_at: "created_at",
  heat_nos: "heat_nos",
  item_code: "item_code",
};

function paginate(page, limit) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  return { safePage, safeLimit, offset: (safePage - 1) * safeLimit };
}

/** By MRN tab — summary grouped by mrn_uid from coils in coil area. */
export async function findPackingAreaByMrn(options = {}) {
  const { search, sort = {}, page = 1, limit = 1000 } = options;
  const values = [];
  let param = 1;
  const conditions = [...PACKING_AREA_WHERE("c")];

  if (search && String(search).trim()) {
    values.push(`%${String(search).trim()}%`);
    const idx = param++;
    conditions.push(`(
      c.mrn_uid ILIKE $${idx}
      OR c.mrn_no::text ILIKE $${idx}
      OR COALESCE(c.heat_no, '') ILIKE $${idx}
      OR COALESCE(c.item_code, '') ILIKE $${idx}
      OR COALESCE(c.item_desc, '') ILIKE $${idx}
      OR COALESCE(c.acc_name, '') ILIKE $${idx}
    )`);
  }

  const where = conditions.join(" AND ");
  const sortCol = SUMMARY_SORT[sort.by] || "mrn_no";
  const sortOrder = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const { safePage, safeLimit, offset } = paginate(page, limit);

  const [{ count = 0 } = {}] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM (
       SELECT c.mrn_uid FROM ${TABLE} c
       WHERE ${where}
       GROUP BY c.mrn_uid
     ) g`,
    values
  );

  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;

  const rows = await dbQuery(
    `SELECT
       c.mrn_uid,
       MAX(c.mrn_no) AS mrn_no,
       MAX(c.serial_no) AS serial_no,
       string_agg(DISTINCT NULLIF(TRIM(c.heat_no), ''), ' | ') AS heat_nos,
       MAX(c.item_dcode) AS item_dcode,
       MAX(NULLIF(TRIM(c.item_code), '')) AS item_code,
       MAX(NULLIF(TRIM(c.item_desc), '')) AS item_desc,
       MAX(c.acc_code) AS acc_code,
       MAX(NULLIF(TRIM(c.acc_name), '')) AS acc_name,
       COALESCE(SUM(c.qty), 0) AS stock_qty,
       COUNT(*)::int AS coil_count,
       MAX(c.total_coils) AS total_coils,
       MIN(c.created_at) AS created_at,
       (array_agg(c.created_by ORDER BY c.created_at ASC NULLS LAST, c.created_by ASC NULLS LAST))[1] AS created_by
     FROM ${TABLE} c
     WHERE ${where}
     GROUP BY c.mrn_uid
     ORDER BY ${sortCol} ${sortOrder} NULLS LAST
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows || [],
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count) / safeLimit) || 0,
  };
}
