/**
 * Coil Area list — coils with no location (not yet racked).
 * By MRN = grouped by mrn_uid + source (MRN Portal + IPR/production-return balances).
 * By Coil = individual coils via findCoils({ coil_area: true }).
 */

import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { coilSourceSql, coilTotalFromUidSql } from "../../../coil/models/coil.model.js";
import { coilAreaEligibleSql, coilAreaPhysicalStatusSql } from "../../../../lib/utils/mrnPortalCoilSql.js";

const TABLE = T.COIL_TABLE;

/** Unassigned MRN stock — physical coil area (QC independent) + shared eligibility rules. */
const PACKING_AREA_WHERE = (alias = "c") => [
  `${alias}.is_deleted = false`,
  `${alias}.location_id IS NULL`,
  `(${coilAreaPhysicalStatusSql(alias)})`,
  `NULLIF(TRIM(${alias}.mrn_uid::text), '') IS NOT NULL`,
  coilAreaEligibleSql(alias),
];

const SUMMARY_SORT = {
  mrn_uid: "mrn_uid",
  mrn_no: "mrn_no",
  source: "source",
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

/** By MRN tab — summary grouped by mrn_uid + source from coils in coil area. */
export async function findPackingAreaByMrn(options = {}) {
  const { search, sort = {}, page = 1, limit = 1000 } = options;
  const values = [];
  let param = 1;
  const conditions = [...PACKING_AREA_WHERE("c")];
  const sourceExpr = coilSourceSql("c");

  if (search && String(search).trim()) {
    values.push(`%${String(search).trim()}%`);
    const idx = param++;
    conditions.push(`(
      c.mrn_uid ILIKE $${idx}
      OR m.mrn_no::text ILIKE $${idx}
      OR COALESCE(m.heat_no, '') ILIKE $${idx}
      OR COALESCE(m.item_code, '') ILIKE $${idx}
      OR COALESCE(m.item_desc, '') ILIKE $${idx}
      OR COALESCE(m.acc_name, '') ILIKE $${idx}
      OR (${sourceExpr}) ILIKE $${idx}
    )`);
  }

  const where = conditions.join(" AND ");
  const sortCol = SUMMARY_SORT[sort.by] || "mrn_no";
  const sortOrder = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const { safePage, safeLimit, offset } = paginate(page, limit);

  const [{ count = 0 } = {}] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM (
       SELECT c.mrn_uid, ${sourceExpr} AS source
       FROM ${TABLE} c
       INNER JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       WHERE ${where}
       GROUP BY c.mrn_uid, ${sourceExpr}
     ) g`,
    values
  );

  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;

  const rows = await dbQuery(
    `SELECT
       c.mrn_uid,
       ${sourceExpr}::varchar AS source,
       MAX(m.mrn_no) AS mrn_no,
       MAX(m.serial_no) AS serial_no,
       string_agg(DISTINCT NULLIF(TRIM(m.heat_no), ''), ' | ') AS heat_nos,
       MAX(m.item_dcode) AS item_dcode,
       MAX(NULLIF(TRIM(m.item_code), '')) AS item_code,
       MAX(NULLIF(TRIM(m.item_desc), '')) AS item_desc,
       MAX(m.acc_code) AS acc_code,
       MAX(NULLIF(TRIM(m.acc_name), '')) AS acc_name,
       COALESCE(SUM(c.qty), 0) AS stock_qty,
       COUNT(*)::int AS coil_count,
       MAX(${coilTotalFromUidSql("c")}) AS total_coils,
       MIN(c.created_at) AS created_at,
       (array_agg(c.created_by ORDER BY c.created_at ASC NULLS LAST, c.created_by ASC NULLS LAST))[1] AS created_by
     FROM ${TABLE} c
     INNER JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     WHERE ${where}
     GROUP BY c.mrn_uid, ${sourceExpr}
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
